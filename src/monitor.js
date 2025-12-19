const { createPublicClient, http } = require('viem');
const { foundry } = require('viem/chains');

// 1. 初始化 RPC 客户端
const client = createPublicClient({
  chain: foundry,
  transport: http('http://127.0.0.1:8545'),
});

let blockHistory = new Map(); // 存储 {高度: 哈希}

async function startMonitor() {
  console.log("🚀 监控启动，正在监听 Anvil 状态...");

  // 使用轮询方式监控，方便在本地环境捕捉 Anvil 的瞬时变化
  setInterval(async () => {
    try {
      const block = await client.getBlock({ blockTag: 'latest' });
      const height = Number(block.number);
      const currentHash = block.hash;
      const parentHash = block.parentHash;

      // 核心逻辑：检查父哈希连续性
      if (blockHistory.has(height - 1)) {
        const expectedParentHash = blockHistory.get(height - 1);
        
        if (parentHash !== expectedParentHash) {
          console.error(`
          ⚠️ 检测到分叉/回滚 (REORG DETECTED)!
          ------------------------------------
          区块高度: ${height}
          当前父哈希: ${parentHash}
          预期父哈希: ${expectedParentHash} (来自旧 Block ${height - 1})
          ------------------------------------
          `);
        }
      }

      // 更新本地索引
      if (blockHistory.get(height) !== currentHash) {
          if(blockHistory.has(height)) {
              console.log(`🔄 高度 ${height} 的哈希已更新 (旧: ${blockHistory.get(height).slice(0,10)}... -> 新: ${currentHash.slice(0,10)}...)`);
          }
          blockHistory.set(height, currentHash);
      }

    } catch (error) {
      // 忽略 Anvil 重启时的连接错误
    }
  }, 1000); // 每秒检查一次
}

startMonitor();
