/**
 * Arbitrum One Reorg Monitor
 * 
 * This script monitors the Arbitrum One blockchain for reorgs, block replacements, and deep rewinds.
 */
const { createPublicClient, http } = require('viem');
const { arbitrum } = require('viem/chains');
require('dotenv').config();

// Configuration: Load Environment Variables
const RPC_URL = process.env.RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
const POLL_INTERVAL_MS = Number.parseInt(process.env.POLL_INTERVAL_MS ?? '', 10) || 150;
const RECHECK_DEPTH = Number.parseInt(process.env.RECHECK_DEPTH ?? '', 10) || 16;
const CACHE_DEPTH = Number.parseInt(process.env.CACHE_DEPTH ?? '', 10) || 2048;
const CHAIN_METADATA_POLL_MS = Number.parseInt(process.env.CHAIN_METADATA_POLL_MS ?? '', 10) || 10_000;
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL;

function defaultLogJson(type, data) {
  const isCritical = data.severity === 'CRITICAL';
  if (isCritical) {
    console.error(`\x1b[31m🚨 CRITICAL ALERT: ${type} 🚨\x1b[0m`);
    // Assuming sendAlert is available in scope or handled by the caller, 
    // but in this structure, sendAlert is inside createMonitor.
    // The defaultLogJson is usually just for console output.
    // The internal logic calls sendAlert separately.
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
      const startHeight = Math.max(0, latestHeight - recheckDepth + 1);
      for (let h = startHeight; h <= lastProcessedHeight; h++) {
        try {
          await processBlock(h);
        } catch (err) {
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
    logJson("MONITOR_START", { message: "Ultra-Detailed Reorg Monitor Active", chain: "Arbitrum One", rpc: RPC_URL });
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
  chain: arbitrum,
  transport: http(RPC_URL),
});

if (require.main === module) {
  createMonitor({ client }).start();
}

module.exports = { createMonitor };
