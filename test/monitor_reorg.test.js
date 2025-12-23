const test = require('node:test');
const assert = require('node:assert/strict');

const { createMonitor } = require('../src/monitor_reorg');

function makeBlock({
  number,
  hash,
  parentHash,
  stateRoot = `0x${String(number).padStart(64, '0')}`,
  txHashes = [],
}) {
  return {
    number: BigInt(number),
    hash,
    parentHash,
    stateRoot,
    baseFeePerGas: 0n,
    gasUsed: 0n,
    transactions: txHashes.map((h) => ({ hash: h })),
  };
}

function cloneBlock(block) {
  return makeBlock({
    number: Number(block.number),
    hash: block.hash,
    parentHash: block.parentHash,
    stateRoot: block.stateRoot,
    txHashes: block.transactions.map((t) => t.hash),
  });
}

class FakeClient {
  #chainId = 1;
  #latestHeight = 0;
  #blocks = new Map();

  setChainId(chainId) {
    this.#chainId = chainId;
  }

  setLatestHeight(height) {
    this.#latestHeight = height;
  }

  setBlock(block) {
    this.#blocks.set(Number(block.number), cloneBlock(block));
  }

  async getChainId() {
    return this.#chainId;
  }

  async getBlock(args) {
    if (args.blockTag === 'latest') {
      const block = this.#blocks.get(this.#latestHeight);
      if (!block) throw new Error('Block not found');
      return cloneBlock(block);
    }

    if (args.blockNumber !== undefined) {
      const height = Number(args.blockNumber);
      const block = this.#blocks.get(height);
      if (!block) throw new Error('Block not found');
      return cloneBlock(block);
    }

    throw new Error('Unsupported getBlock args');
  }
}

// 先创建一部分的区块，用于测试
function createLinearChain({ from, to, genesisHash = '0xgenesis' }) {
  const blocks = [];
  for (let h = from; h <= to; h++) {
    if (h === 0) {
      blocks.push(makeBlock({ number: 0, hash: genesisHash, parentHash: genesisHash }));
      continue;
    }
    const parentHash = blocks[blocks.length - 1].hash;
    blocks.push(makeBlock({ number: h, hash: `0xblock${h}`, parentHash, txHashes: [`0xtx${h}a`, `0xtx${h}b`] }));
  }
  return blocks;
}

// 测试当最新高度下降时是否检测到 CHAIN_REWIND
test('detects CHAIN_REWIND when latest height decreases', async () => {
  const client = new FakeClient();
  const events = [];
  let nowMs = 0;

  for (const block of createLinearChain({ from: 0, to: 5 })) client.setBlock(block);
  client.setLatestHeight(5);

  const monitor = createMonitor({
    client,
    logJson: (type, data) => events.push({ type, data }),
    chainMetadataPollMs: 0,
    now: () => nowMs,
  });

  await monitor.tick();

  client.setLatestHeight(3);
  nowMs += 1;
  await monitor.tick();

  const rewind = events.find((e) => e.type === 'CHAIN_REWIND');
  assert.ok(rewind, 'expected CHAIN_REWIND');
  assert.equal(rewind.data.from_height, 5);
  assert.equal(rewind.data.to_height, 3);
});

// 测试当区块高度相同时，哈希的变化是否检测到 BLOCK_REPLACED 事件
test('detects BLOCK_REPLACED with tx diff when same height hash changes', async () => {
  const client = new FakeClient();
  const events = [];
  let nowMs = 0;

  for (const block of createLinearChain({ from: 0, to: 2 })) client.setBlock(block);
  client.setLatestHeight(2);

  const monitor = createMonitor({
    client,
    logJson: (type, data) => events.push({ type, data }),
    chainMetadataPollMs: 0,
    now: () => nowMs,
  });

  await monitor.tick();

  client.setBlock(makeBlock({
    number: 2,
    hash: '0xblock2_new',
    parentHash: '0xblock1',
    stateRoot: '0xstate2_new',
    txHashes: ['0xtx2b', '0xtx2c'],
  }));

  nowMs += 1;
  await monitor.tick();

  const replaced = events.find((e) => e.type === 'BLOCK_REPLACED' && e.data.height === 2);
  assert.ok(replaced, 'expected BLOCK_REPLACED for height 2');
  assert.equal(replaced.data.old_hash, '0xblock2');
  assert.equal(replaced.data.new_hash, '0xblock2_new');
  assert.deepEqual(replaced.data.tx_diff.dropped.sort(), ['0xtx2a'].sort());
  assert.deepEqual(replaced.data.tx_diff.added.sort(), ['0xtx2c'].sort());
});

// 测试当区块高度相同时，parent哈希的变化是否检测到 REORG_DETECTED 事件
test('detects REORG_DETECTED when parent hash becomes discontinuous', async () => {
  const client = new FakeClient();
  const events = [];
  let nowMs = 0;

  for (const block of createLinearChain({ from: 0, to: 2 })) client.setBlock(block);
  client.setLatestHeight(2);

  const monitor = createMonitor({
    client,
    logJson: (type, data) => events.push({ type, data }),
    chainMetadataPollMs: 0,
    now: () => nowMs,
  });

  await monitor.tick();

  client.setBlock(makeBlock({
    number: 2,
    hash: '0xblock2_reorg',
    parentHash: '0xsome_other_parent',
    txHashes: ['0xtx2x'],
  }));

  nowMs += 1;
  await monitor.tick();

  const reorg = events.find((e) => e.type === 'REORG_DETECTED' && e.data.at_height === 2);
  assert.ok(reorg, 'expected REORG_DETECTED at height 2');
  assert.equal(reorg.data.expected_parent, '0xblock1');
  assert.equal(reorg.data.actual_parent, '0xsome_other_parent');
});

// 测试当区块高度相同时，parent哈希的变化是否检测到 REORG_DETECTED 事件，且在recheck窗口内
test('detects non-tip reorg via recheck window', async () => {
  const client = new FakeClient();
  const events = [];
  let nowMs = 0;

  for (const block of createLinearChain({ from: 0, to: 10 })) client.setBlock(block);
  client.setLatestHeight(10);

  const monitor = createMonitor({
    client,
    logJson: (type, data) => events.push({ type, data }),
    chainMetadataPollMs: 0,
    recheckDepth: 5,
    now: () => nowMs,
  });

  await monitor.tick();

  client.setBlock(makeBlock({
    number: 8,
    hash: '0xblock8_new',
    parentHash: '0xblock7',
    txHashes: ['0xtx8z'],
  }));

  nowMs += 1;
  await monitor.tick();

  const replaced = events.find((e) => e.type === 'BLOCK_REPLACED' && e.data.height === 8);
  assert.ok(replaced, 'expected BLOCK_REPLACED for height 8');
});

// 测试当区块高度相同时，parent哈希的变化是否检测到 REORG_DETECTED 事件，且在recheck窗口外
test('trims cache to CACHE_DEPTH', async () => {
  const client = new FakeClient();
  const events = [];

  for (const block of createLinearChain({ from: 0, to: 10 })) client.setBlock(block);
  client.setLatestHeight(10);

  const monitor = createMonitor({
    client,
    logJson: (type, data) => events.push({ type, data }),
    chainMetadataPollMs: 0,
    cacheDepth: 3,
    now: () => 0,
  });

  await monitor.tick();

  const { blockCache } = monitor.getState();
  const heights = [...blockCache.keys()].sort((a, b) => a - b);
  assert.deepEqual(heights, [8, 9, 10]);
});

// 测试当chainId或genesisHash变化时，是否检测到 CHAIN_ID_CHANGED 和 GENESIS_CHANGED 事件
test('detects chain reset signals via chainId/genesis changes', async () => {
  const client = new FakeClient();
  const events = [];
  let nowMs = 0;

  for (const block of createLinearChain({ from: 0, to: 1, genesisHash: '0xgenesis_a' })) client.setBlock(block);
  client.setLatestHeight(1);

  const monitor = createMonitor({
    client,
    logJson: (type, data) => events.push({ type, data }),
    chainMetadataPollMs: 0,
    now: () => nowMs,
  });

  await monitor.tick();

  client.setChainId(2);
  client.setBlock(makeBlock({ number: 0, hash: '0xgenesis_b', parentHash: '0xgenesis_b' }));

  nowMs += 1;
  await monitor.tick();

  assert.ok(events.some((e) => e.type === 'CHAIN_ID_CHANGED'), 'expected CHAIN_ID_CHANGED');
  assert.ok(events.some((e) => e.type === 'GENESIS_CHANGED'), 'expected GENESIS_CHANGED');
});

// 测试当RPC返回"Block not found"错误时，是否抑制该事件，其他错误是否记录
test('suppresses RPC_ERROR for "Block not found", logs otherwise', async () => {
  const client = new FakeClient();
  const events = [];
  const monitor = createMonitor({
    client,
    logJson: (type, data) => events.push({ type, data }),
    chainMetadataPollMs: 0,
    now: () => 0,
  });

  await monitor.tick();
  assert.ok(!events.some((e) => e.type === 'RPC_ERROR'), 'expected no RPC_ERROR for Block not found');

  client.getBlock = async () => {
    throw new Error('boom');
  };

  await monitor.tick();
  assert.ok(events.some((e) => e.type === 'RPC_ERROR'), 'expected RPC_ERROR for generic failure');
});

