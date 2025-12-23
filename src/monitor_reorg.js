const { createPublicClient, http } = require('viem');
const { foundry } = require('viem/chains');
const { sendAlert } = require('./alert_send');
require('dotenv').config();

// Configuration: Load Environment Variables
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const POLL_INTERVAL_MS = Number.parseInt(process.env.POLL_INTERVAL_MS ?? '', 10) || 150;
const RECHECK_DEPTH = Number.parseInt(process.env.RECHECK_DEPTH ?? '', 10) || 16;
const CACHE_DEPTH = Number.parseInt(process.env.CACHE_DEPTH ?? '', 10) || 2048;
const CHAIN_METADATA_POLL_MS = Number.parseInt(process.env.CHAIN_METADATA_POLL_MS ?? '', 10) || 10_000;
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL;

function defaultLogJson(type, data) {
  const isCritical = data.severity === 'CRITICAL';
  if (isCritical) {
    console.error(`\x1b[31m🚨 CRITICAL ALERT: ${type} 🚨\x1b[0m`);
    sendAlert(type, data);
  }
  const logFn = isCritical ? console.error : console.log;
  logFn(JSON.stringify({
    timestamp: new Date().toISOString(),
    event_type: type,
    ...data
  }, null, 2));
}

/**
 * Main Monitor Factory
 * Handles Block Polling, Reorg Detection, and Alerting.
 */
function createMonitor({
  client,
  logJson = defaultLogJson,
  pollIntervalMs = POLL_INTERVAL_MS,
  recheckDepth = RECHECK_DEPTH,
  cacheDepth = CACHE_DEPTH,
  chainMetadataPollMs = CHAIN_METADATA_POLL_MS,
  alertWebhookUrl = ALERT_WEBHOOK_URL,
  now = () => Date.now(),
} = {}) {
  if (!client) throw new Error('client is required');

  /**
   * 触发警报
   */
  async function sendAlert(type, data) {
    if (!alertWebhookUrl) return;
    try {
      const message = `🚨 **${type}** 🚨\n\n` +
        `Severity: ${data.severity || 'UNKNOWN'}\n` +
        `Details: \`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;

      // Compatible with Slack (text) and Discord (content)
      const body = JSON.stringify({
        content: message, 
        text: message
      });

      await fetch(alertWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });
    } catch (err) {
      console.error('Failed to send alert:', err);
    }
  }

  // State Management
  let blockCache = new Map(); // Cache for Reorg detection
  let maxObservedHeight = 0;  // Track Max Height to detect Rewind
  let lastProcessedHeight = -1;
  let lastChainId = null;
  let lastGenesisHash = null;
  let lastMetadataCheckMs = 0;

    async function processBlock(blockNumber) {
    // Let errors propagate to the caller for better handling
    const block = await client.getBlock({ 
      blockNumber: BigInt(blockNumber), 
      includeTransactions: true 
    });
    
    const height = Number(block.number);
    const hash = block.hash;
    const parentHash = block.parentHash;
    const txHashes = block.transactions.map(t => t.hash);
    const txHashSet = new Set(txHashes);

    // 检查是否是新的高度
    // Check: Block Replaced (Same Height, Different Hash)
    // This indicates a Fork or Reorg at the tip.
    if (blockCache.has(height)) {
      const cached = blockCache.get(height);
      if (cached.hash !== hash) {
        const cachedTxHashSet = new Set(cached.transactions);
        const eventData = {
          height,
          old_hash: cached.hash,
          new_hash: hash,
          old_state_root: cached.stateRoot,
          new_state_root: block.stateRoot,
          tx_diff: {
            dropped: cached.transactions.filter(tx => !txHashSet.has(tx)),
            added: txHashes.filter(tx => !cachedTxHashSet.has(tx))
          },
          severity: "CRITICAL" // Marked as CRITICAL
        };
        logJson("BLOCK_REPLACED", eventData);
        sendAlert("BLOCK_REPLACED", eventData);
      }
    }
    
    // 监测是否rollback，Parent Hash Mismatch
    // Check: Reorg Detected (Parent Hash Mismatch)
    // Checks if the current block's Parent Hash matches the cached block at height-1.
    if (blockCache.has(height - 1)) {
      const parent = blockCache.get(height - 1);
      if (parentHash !== parent.hash) {
        const alertData = {
          at_height: height,
          expected_parent: parent.hash,
          actual_parent: parentHash,
          severity: "CRITICAL"
        };
        logJson("PARENT_HASH_MISMATCH_DETECTED", alertData);
        sendAlert("PARENT_HASH_MISMATCH_DETECTED", alertData);
      }
    }

    // Update Cache if new block or replaced
    if (!blockCache.has(height) || blockCache.get(height).hash !== hash) {
      logJson("BLOCK_RECEIVED", {
        height,
        hash,
        parent_hash: parentHash,
        state_root: block.stateRoot,
        base_fee: block.baseFeePerGas?.toString(),
        gas_used: block.gasUsed.toString(),
        tx_count: txHashes.length,
        transactions: txHashes
      });

      blockCache.set(height, {
        hash,
        parentHash,
        stateRoot: block.stateRoot,
        transactions: txHashes
      });
    }

    if (height > maxObservedHeight) maxObservedHeight = height;
    return true;
  }

  async function tick() {
    try {
      const nowMs = now();
      
      // Periodic Chain Metadata Check (ChainId, Genesis)
      if (nowMs - lastMetadataCheckMs >= chainMetadataPollMs) {
        lastMetadataCheckMs = nowMs;
        const [chainId, genesis] = await Promise.all([
          client.getChainId(),
          client.getBlock({ blockNumber: 0n })
        ]);

        if (lastChainId !== null && chainId !== lastChainId) {
          const alertData = { old_chain_id: lastChainId, new_chain_id: chainId, severity: "CRITICAL" };
          logJson("CHAIN_ID_CHANGED", alertData);
          sendAlert("CHAIN_ID_CHANGED", alertData);
        }
        lastChainId = chainId;

        if (lastGenesisHash !== null && genesis.hash !== lastGenesisHash) {
          const alertData = { old_genesis_hash: lastGenesisHash, new_genesis_hash: genesis.hash, severity: "CRITICAL" };
          logJson("GENESIS_CHANGED", alertData);
          sendAlert("GENESIS_CHANGED", alertData);
        }
        lastGenesisHash = genesis.hash;
      }

      const latestBlock = await client.getBlock({ blockTag: 'latest' });
      const latestHeight = Number(latestBlock.number);

      // Check: Chain Rewind (Latest Height < Max Observed Height)
      // Indicates the chain tip has rolled back (Deep Reorg).
      if (latestHeight < maxObservedHeight) {
        const alertData = {
          from_height: maxObservedHeight,
          to_height: latestHeight,
          severity: "CRITICAL"
        };
        logJson("CHAIN_REWIND", alertData);
        sendAlert("CHAIN_REWIND", alertData);
        maxObservedHeight = latestHeight;
        lastProcessedHeight = latestHeight;
      }

      // Process new blocks (Forward Sync)
      // Stop immediately if any block fails to ensure we don't skip blocks
      if (latestHeight > lastProcessedHeight) {
        for (let h = lastProcessedHeight + 1; h <= latestHeight; h++) {
          if (h < 0) continue;
          try {
            await processBlock(h);
            lastProcessedHeight = h; // Only update on success
          } catch (err) {
            logJson("RPC_ERROR", { message: `Failed to process block ${h}`, error: err.message });
            break; // Stop syncing to retry this block next tick
          }
        }
      }

      // Recheck recent blocks (Deep Reorg Detection)
      // Optimization: Don't recheck blocks we just processed in Forward Sync
      // We only recheck blocks up to (lastProcessedHeight - 1) or (latestHeight) depending on what we want.
      // Actually, Forward Sync ensures we have the blocks. Recheck ensures they haven't changed.
      // If we just fetched block X in Forward Sync, we don't need to recheck it immediately in the same tick.
      
      // Define the range we want to verify (e.g., latest 16 blocks)
      const startHeight = Math.max(0, latestHeight - recheckDepth + 1);
      // We stop at lastProcessedHeight because anything above that was either just added (so it's fresh)
      // or we failed to reach it (so we can't recheck it anyway).
      // However, if lastProcessedHeight moved forward this tick, those new blocks are fresh.
      // So we can limit recheck to `min(latestHeight, originalLastProcessedHeight)`? 
      // Simpler: Just recheck everything but skip if we *just* added it?
      // Let's stick to: Recheck up to latestHeight, but logic inside processBlock handles duplicates gracefully.
      // But to save RPC, let's only recheck blocks that were NOT just added.
      // Since lastProcessedHeight is updated in the loop above, we can't easily know which ones were "just" added unless we track it.
      // Simpler approach: Recheck range is [latestHeight - recheckDepth + 1, latestHeight].
      // But we can skip if `h` was processed in the Forward Sync loop above? 
      // Actually, standardizing is safer. Let's just run it. The cache check inside processBlock is fast, but we want to avoid RPC.
      // But wait, processBlock DOES call RPC every time. That's the point of recheck.
      // So yes, we should avoid calling processBlock again for blocks we just fetched.
      
      // To do this cleanly: 
      // The blocks we just fetched are: (oldLastProcessedHeight + 1) ... lastProcessedHeight
      // The blocks we need to recheck: (latestHeight - recheckDepth + 1) ... latestHeight
      // So we should intersect these sets and remove the ones we just fetched.
      // Effectively: Recheck up to `Math.min(latestHeight, oldLastProcessedHeight)`?
      // No, that's not quite right because oldLastProcessedHeight isn't stored.
      
      // Let's keep it simple for now to ensure correctness over optimization, 
      // but definitely use the `lastProcessedHeight` variable which now reflects the *actual* processed tip.
      
      for (let h = startHeight; h <= lastProcessedHeight; h++) {
        // Simple optimization: If we are very close to the tip, and we just synced it, 
        // we might be double-checking. But given the logic, let's prioritize correctness.
        // We catch errors here individually so one failure doesn't stop the whole recheck
        try {
          await processBlock(h);
        } catch (err) {
           // Log but continue rechecking other blocks
           // Unless it's a connection error, but let's assume transient
           // Suppress "Block not found" log spam if needed, or just log everything
           logJson("RPC_ERROR", { message: `Recheck failed for ${h}`, error: err.message });
        }
      }

      // Prune Cache
      const minHeightToKeep = Math.max(0, latestHeight - cacheDepth + 1);
      for (const height of blockCache.keys()) {
        if (height < minHeightToKeep) blockCache.delete(height);
      }
    } catch (err) {
      const message = err?.message ?? String(err);
      if (!message.includes("Block not found")) {
        logJson("RPC_ERROR", { error: message });
      }
    }
  }

  function start() {
    logJson("MONITOR_START", { message: "Ultra-Detailed Reorg Monitor Active" });
    const intervalId = setInterval(() => {
      tick();
    }, pollIntervalMs);
    return () => clearInterval(intervalId);
  }

  function getState() {
    return {
      blockCache,
      maxObservedHeight,
      lastProcessedHeight,
      lastChainId,
      lastGenesisHash,
    };
  }

  return { tick, start, getState };
}

const client = createPublicClient({
  chain: foundry,
  transport: http(RPC_URL),
});

if (require.main === module) {
  createMonitor({ client }).start();
}

module.exports = { createMonitor };
