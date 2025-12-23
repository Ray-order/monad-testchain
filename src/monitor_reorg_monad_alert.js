/**
 * Monad Mainnet Reorg Monitor
 * 
 * This script monitors the Monad Mainnet for reorgs, block replacements, and deep rewinds.
 * 
 * ## Deployment Instructions
 * 
 * 1. **Environment Setup**:
 *    - Ensure Node.js (v18+) is installed.
 *    - Install dependencies: `npm install`
 * 
 * 2. **Configuration**:
 *    - The script defaults to Monad Mainnet (RPC: https://rpc.monad.xyz).
 *    - You can override settings using environment variables or a `.env` file:
 *      ```
 *      RPC_URL=https://rpc.monad.xyz
 *      ALERT_WEBHOOK_URL=https://discord.com/api/webhooks/...  # Optional: For Slack/Discord alerts
 *      POLL_INTERVAL_MS=150
 *      ```
 * 
 * 3. **Running in Production**:
 *    - It is recommended to use a process manager like PM2 to keep the script running.
 *    - Since PM2 is installed locally, use `npx` or the provided npm scripts:
 *      ```bash
 *      # Using npm scripts (Recommended)
 *      npm run monitor:monad:start
 *      
 *      # Or using npx directly
 *      npx pm2 start src/monitor_reorg_monad.js --name monad-monitor
 *      npx pm2 save
 *      ```
 *    - Alternatively, use Docker.
 * 
 * 4. **Logs**:
 *    - Logs are output to stdout in JSON format for easy ingestion by logging systems (e.g., Datadog, ELK).
 */
const { createPublicClient, http, defineChain } = require('viem');

// Define Monad Mainnet Chain
const monadMainnet = defineChain({
  id: 143,
  name: 'Monad Mainnet',
  nativeCurrency: {
    decimals: 18,
    name: 'Monad',
    symbol: 'MON',
  },
  rpcUrls: {
    default: { http: ['https://rpc.monad.xyz'] },
  },
  blockExplorers: {
    default: { name: 'MonadScan', url: 'https://monadscan.com' },
  },
  testnet: false,
});

// Configuration: Load Environment Variables
const RPC_URL = process.env.RPC_URL ?? 'https://rpc.monad.xyz';
// Increased default poll interval to 5000ms to aggressively avoid 429 Rate Limit
const POLL_INTERVAL_MS = Number.parseInt(process.env.POLL_INTERVAL_MS ?? '', 10) || 5000;
const RECHECK_DEPTH = Number.parseInt(process.env.RECHECK_DEPTH ?? '', 10) || 16;
const CACHE_DEPTH = Number.parseInt(process.env.CACHE_DEPTH ?? '', 10) || 2048;
const CHAIN_METADATA_POLL_MS = Number.parseInt(process.env.CHAIN_METADATA_POLL_MS ?? '', 10) || 10_000;
const HOURLY_REPORT_INTERVAL_MS = Number.parseInt(process.env.HOURLY_REPORT_INTERVAL_MS ?? '', 10) || 3600 * 1000;
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL;

function defaultLogJson(type, data) {
  console.log(JSON.stringify({
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
  hourlyReportIntervalMs = HOURLY_REPORT_INTERVAL_MS,
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

  // Hourly Stats
  let hourlyStats = {
    startTime: now(),
    blocksProcessed: 0,
    reorgsDetected: 0,
    blocksReplaced: 0,
    chainRewinds: 0,
  };

  function resetHourlyStats() {
    hourlyStats = {
      startTime: now(),
      blocksProcessed: 0,
      reorgsDetected: 0,
      blocksReplaced: 0,
      chainRewinds: 0,
    };
  }

  async function generateHourlyReport() {
    const durationMinutes = (now() - hourlyStats.startTime) / 60000;
    const report = {
      report_type: "HOURLY_ANALYSIS",
      duration_minutes: durationMinutes.toFixed(2),
      stats: { ...hourlyStats },
      threat_assessment: "LOW",
      threat_details: []
    };

    // Determine Threat Level
    const reasons = [];
    if (hourlyStats.chainRewinds > 0) {
      report.threat_assessment = "CRITICAL";
      reasons.push("Chain rewind detected");
    } else if (hourlyStats.reorgsDetected > 5 || hourlyStats.blocksReplaced > 10) {
      report.threat_assessment = "HIGH";
      reasons.push("High frequency of reorgs/replacements");
    } else if (hourlyStats.reorgsDetected > 0 || hourlyStats.blocksReplaced > 0) {
      report.threat_assessment = "MEDIUM";
      reasons.push("Minor reorg activity observed");
    }

    report.threat_details = reasons;

    logJson("HOURLY_REPORT", report);
    
    // Alert if threat is not LOW
    if (report.threat_assessment !== "LOW") {
        await sendAlert("HOURLY_THREAT_REPORT", report);
    }

    resetHourlyStats();
  }

  async function processBlock(blockNumber) {
    try {
      const block = await client.getBlock({ 
        blockNumber: BigInt(blockNumber), 
        includeTransactions: true 
      });
      
      const height = Number(block.number);
      const hash = block.hash;
      const parentHash = block.parentHash;
      const txHashes = block.transactions.map(t => t.hash);
      const txHashSet = new Set(txHashes);

      hourlyStats.blocksProcessed++;

      // 检查是否是新的高度
      // Check: Block Replaced (Same Height, Different Hash)
      // This indicates a Fork or Reorg at the tip.
      if (blockCache.has(height)) {
        const cached = blockCache.get(height);
        if (cached.hash !== hash) {
          hourlyStats.blocksReplaced++;
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
          hourlyStats.reorgsDetected++;
          const alertData = {
            at_height: height,
            expected_parent: parent.hash,
            actual_parent: parentHash,
            severity: "CRITICAL"
          };
          logJson("REORG_DETECTED", alertData);
          sendAlert("REORG_DETECTED", alertData);
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
    } catch {
      return false;
    }
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
          logJson("CHAIN_ID_CHANGED", { old_chain_id: lastChainId, new_chain_id: chainId, severity: "CRITICAL" });
        }
        lastChainId = chainId;

        if (lastGenesisHash !== null && genesis.hash !== lastGenesisHash) {
          logJson("GENESIS_CHANGED", { old_genesis_hash: lastGenesisHash, new_genesis_hash: genesis.hash, severity: "CRITICAL" });
        }
        lastGenesisHash = genesis.hash;
      }

      const latestBlock = await client.getBlock({ blockTag: 'latest' });
      const latestHeight = Number(latestBlock.number);

      // Optimization: On first run, skip historical blocks to avoid long catch-up time.
      // We set lastProcessedHeight to just before the current tip, so we only process the latest block.
      if (lastProcessedHeight === -1 && latestHeight > 0) {
        logJson("MONITOR_SKIP_HISTORY", { 
          message: "Skipping historical blocks to start from latest", 
          skipped_to_height: latestHeight 
        });
        lastProcessedHeight = latestHeight - 1;
      }

      // Check: Chain Rewind (Latest Height < Max Observed Height)
      // Indicates the chain tip has rolled back (Deep Reorg).
      if (latestHeight < maxObservedHeight) {
        hourlyStats.chainRewinds++;
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
      if (latestHeight > lastProcessedHeight) {
        for (let h = lastProcessedHeight + 1; h <= latestHeight; h++) {
          if (h < 0) continue;
          await processBlock(h);
        }
        lastProcessedHeight = latestHeight;
      }

      // Recheck recent blocks (Deep Reorg Detection)
      // Re-verifies blocks within RECHECK_DEPTH to ensure they haven't changed.
      const startHeight = Math.max(0, latestHeight - recheckDepth + 1);
      for (let h = startHeight; h <= latestHeight; h++) {
        await processBlock(h);
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
    logJson("MONITOR_START", { message: "Ultra-Detailed Reorg Monitor Active", chain: "Monad Mainnet", rpc: RPC_URL });
    
    // Poll Loop
    const intervalId = setInterval(() => {
      tick();
    }, pollIntervalMs);

    // Hourly Analysis Loop
    const reportIntervalId = setInterval(() => {
        generateHourlyReport();
    }, hourlyReportIntervalMs);

    return () => {
        clearInterval(intervalId);
        clearInterval(reportIntervalId);
    };
  }

  function getState() {
    return {
      blockCache,
      maxObservedHeight,
      lastProcessedHeight,
      lastChainId,
      lastGenesisHash,
      hourlyStats,
    };
  }

  return { tick, start, getState };
}

if (require.main === module) {
  // Initialize client here to access monadMainnet scope
  const client = createPublicClient({
    chain: monadMainnet,
    transport: http(RPC_URL, {
      retryCount: 3,
      retryDelay: 1000,
    }),
  });
  
  createMonitor({ client }).start();
}

module.exports = { createMonitor };
