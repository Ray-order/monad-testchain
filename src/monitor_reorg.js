const { createPublicClient, http } = require('viem');
const { foundry } = require('viem/chains');

// 配置 RPC 地址（针对你的 Anvil 节点）
const client = createPublicClient({
  chain: foundry,
  transport: http('http://127.0.0.1:8545'),
});

// 本地状态缓存（内存索引）
let blockCache = new Map(); // { blockNumber: { hash, parentHash } }
const MAX_CACHE_SIZE = 100;

/**
 * 格式化 JSON 输出
 */
function logJson(type, data) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    event_type: type,
    ...data
  }));
}

async function startMonitor() {
  logJson("MONITOR_START", { message: "Watching for Reorgs on Anvil..." });

  setInterval(async () => {
    try {
      const block = await client.getBlock({ blockTag: 'latest' });
      const currentNumber = Number(block.number);
      const currentHash = block.hash;
      const currentParentHash = block.parentHash;

      // 检查父哈希连续性 (The Continuity Check)
      if (blockCache.has(currentNumber - 1)) {
        const previousBlock = blockCache.get(currentNumber - 1);
        
        if (currentParentHash !== previousBlock.hash) {
          // 检测到 REORG!
          logJson("REORG_DETECTED", {
            height: currentNumber,
            actual_parent_hash: currentParentHash,
            expected_parent_hash: previousBlock.hash,
            reorg_depth: calculateDepth(currentNumber),
            severity: "HIGH"
          });
        }
      }

      // 更新缓存
      if (!blockCache.has(currentNumber) || blockCache.get(currentNumber).hash !== currentHash) {
        logJson("BLOCK_RECEIVED", {
          height: currentNumber,
          hash: currentHash,
          parent_hash: currentParentHash,
          tx_count: block.transactions.length
        });
        
        blockCache.set(currentNumber, { hash: currentHash, parentHash: currentParentHash });
        
        // 自动清理过旧缓存
        if (blockCache.size > MAX_CACHE_SIZE) {
          const oldestKey = Math.min(...blockCache.keys());
          blockCache.delete(oldestKey);
        }
      }
    } catch (err) {
      logJson("RPC_ERROR", { error: err.message });
    }
  }, 1000); // 1秒轮询一次
}

function calculateDepth(currentHeight) {
  // 逻辑：向上回溯直到找到共同祖先，返回深度
  return "Calculated based on fork point"; 
}

startMonitor();