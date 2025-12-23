#!/bin/bash

# --- 强制配置 ---
# 这里的 RPC_URL 必须指向你刚才启动的 anvil
export ETH_RPC_URL="http://127.0.0.1:8545"
RPC_URL="http://127.0.0.1:8545"

# Anvil 默认账户 0 和 1 的私钥 (本地必有钱)
KEY_A="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
KEY_B="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
ADDR_TO="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

log() { echo -e "\n\033[1;36m[Experiment] $1\033[0m"; }

# 检查连接的是否是本地链
CHAIN_ID=$(cast chain-id)
if [ "$CHAIN_ID" != "31337" ]; then
    echo "❌ 错误: 当前连接的 Chain ID 是 $CHAIN_ID (不是 Anvil 的 31337)"
    echo "请检查是否有 .env 文件干扰，或者 anvil 是否未启动。"
    exit 1
fi

log "✅ 连接成功: Local Anvil (Chain ID: 31337)"

# ==========================================
# 场景 1: Chain Rewind
# ==========================================
log "Step 1: 制造基础高度 (Mining 5 blocks)..."
cast rpc anvil_mine 5 > /dev/null
current_height=$(cast block-number)
log "当前高度: $current_height"
sleep 2

log "Step 2: 创建Snapshot..."
SNAP_ID=$(cast rpc evm_snapshot | tr -d '"')
log "Snapshot ID: $SNAP_ID"

log "Step 3: 出块 (Mining 3 more blocks)..."
cast rpc anvil_mine 3 > /dev/null
sleep 2
log "当前高度已增加到: $(cast block-number)"

log "Step 4: 触发rollback (TRIGGER REWIND)..."
cast rpc evm_revert "$SNAP_ID" > /dev/null
log "已回滚! 监控应检测到 CHAIN_REWIND."
sleep 2

# ==========================================
# 场景 2: Block Replaced & Tx Diff
# ==========================================
log "Step 5: 准备 Block Replacement 实验..."
SNAP_ID_2=$(cast rpc evm_snapshot | tr -d '"')

log "Step 6: [路径 A] 发送交易 TX_A 并出块..."
# 增加 --gas-limit 防止估算错误，强制使用本地 RPC
TX_A=$(cast send --rpc-url $RPC_URL --private-key $KEY_A $ADDR_TO --value 0.1ether --gas-limit 21000 --async)
cast rpc anvil_mine 1 > /dev/null
log "Block mined with TX_A: $TX_A"
sleep 2

log "Step 7: rollback并制造分叉 (Revert & Fork)..."
cast rpc evm_revert "$SNAP_ID_2" > /dev/null

log "Step 8: [路径 B] 发送不同的交易 TX_B 并出块..."
TX_B=$(cast send --rpc-url $RPC_URL --private-key $KEY_B $ADDR_TO --value 0.2ether --gas-limit 21000 --async)
cast rpc anvil_mine 1 > /dev/null
log "Block replaced with TX_B: $TX_B"
log "监控应检测到 BLOCK_REPLACED"
sleep 2

# ==========================================
# 场景 3: Deep Reorg
# ==========================================
log "Step 9: 模拟非 Tip 端的深层重组..."
SNAP_ID_3=$(cast rpc evm_snapshot | tr -d '"')

log "Step 10: 挖 5 个块 (旧链)..."
cast rpc anvil_mine 5 > /dev/null
sleep 2

log "Step 11: 回滚到 5 个块之前..."
cast rpc evm_revert "$SNAP_ID_3" > /dev/null

log "Step 12: 重新挖 5 个空块 (新链)..."
cast rpc anvil_mine 5 > /dev/null

log "实验结束。"