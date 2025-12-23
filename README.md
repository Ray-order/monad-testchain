## Monad-flavored Foundry

> [!NOTE]
> In this Foundry template, the default chain is `monadTestnet`. If you wish to change it, change the network in `foundry.toml`

<h4 align="center">
  <a href="https://docs.monad.xyz">Monad Documentation</a> | <a href="https://book.getfoundry.sh/">Foundry Documentation</a> |
   <a href="https://github.com/monad-developers/foundry-monad/issues">Report Issue</a>
</h4>

### Quick Start with Docker (Recommended)

We provide Docker support to get you up and running quickly without worrying about Node.js versions or dependencies.

#### 1. Run in Production Mode
To start the monitors in the background:

```bash
docker-compose up -d
```

This will start:
- `monad-monitor`: Monitors Monad Testnet
- `base-monitor`: Monitors Base Testnet

View logs:
```bash
docker-compose logs -f
# Or for a specific service
docker-compose logs -f monad-monitor
docker-compose logs -f base-monitor
```

#### 2. Run in Development Mode
For local development with **hot-reloading**:

```bash
docker-compose up monad-monitor-dev
```
- This mounts your local directory into the container.
- Changes to files in `src/` will automatically restart the application.
- Ideal for testing changes without rebuilding images.

---

### Configuration

You can configure the monitors using environment variables in `docker-compose.yml` or a `.env` file:

| Variable | Description | Default |
|----------|-------------|---------|
| `RPC_URL` | Monad RPC Endpoint | `https://testnet-rpc.monad.xyz` |
| `BASE_RPC_URL` | Base RPC Endpoint | `https://sepolia.base.org` |
| `POLL_INTERVAL_MS` | Polling interval in ms | `150` |
| `ALERT_WEBHOOK_URL`| (Optional) Slack/Discord Webhook | `""` |

---

### Monitoring Events

The monitor tracks the following chain reorganization events:

| Event Type | Meaning | Trigger Condition |
|------------|---------|-------------------|
| `BLOCK_REPLACED` | Block hash changed at same height | Cached block exists but new block hash differs (Note: Deep reorgs/rewinds clear cache to avoid duplicate alerts here). |
| `PARENT_HASH_MISMATCH_DETECTED` | Parent hash mismatch | Block's Parent Hash doesn't match the cached hash of the previous block (Height-1). Indicates a fork/reorg at the tip. |
| `CHAIN_REWIND` | Chain tip rolled back (Deep Reorg) | Latest block height < Max observed height. Indicates the canonical chain has become shorter (rewound). |
| `CHAIN_ID_CHANGED` | Chain ID changed | The network Chain ID returned by RPC differs from the previously recorded ID. |
| `GENESIS_CHANGED` | Genesis block changed | The hash of block 0 changed. Indicates a network reset or hard fork. |

---

### Manual Setup (Without Docker)

If you prefer running locally with Node.js:

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Run Monitors**
   ```bash
   # Monitor Monad
   npm run monitor:monad

   # Monitor Base
   npm run monitor:base
   ```

---

## Foundry Template Info (Original README)

**Foundry is a blazing fast, portable and modular toolkit for Ethereum application development written in Rust.**

Foundry consists of:

-   **Forge**: Ethereum testing framework (like Truffle, Hardhat, and DappTools).
-   **Cast**: Swiss army knife for interacting with EVM smart contracts, sending transactions, and getting chain data.
-   **Anvil**: Local Ethereum node, akin to Ganache, Hardhat Network.
-   **Chisel**: Fast, utilitarian, and verbose Solidity REPL.

## Documentation

https://book.getfoundry.sh/

## Usage

### Build

```shell
forge build
```

### Test

```shell
forge test
```

### Format

```shell
forge fmt
```

### Gas Snapshots

```shell
forge snapshot
```

### Anvil

```shell
anvil
```

### Deploy to Monad Testnet

First, you need to create a keystore file. Do not forget to remember the password! You will need it to deploy your contract.

```shell
cast wallet import monad-deployer --private-key $(cast wallet new | grep 'Private key:' | awk '{print $3}')
```

After creating the keystore, you can read its address using:

```shell
cast wallet address --account monad-deployer
```

The command above will create a keystore file named `monad-deployer` in the `~/.foundry/keystores` directory.

Then, you can deploy your contract to the Monad Testnet using the keystore file you created.

```shell
forge create src/Counter.sol:Counter --account monad-deployer --broadcast
```

### Verify Contract

```shell
forge verify-contract \
  <contract_address> \
  src/Counter.sol:Counter \
  --chain 10143 \
  --verifier sourcify \
  --verifier-url https://sourcify-api-monad.blockvision.org
```

### Cast
[Cast reference](https://book.getfoundry.sh/cast/)
```shell
cast <subcommand>
```

### Help

```shell
forge --help
anvil --help
cast --help
```


## FAQ

### Error: `Error: server returned an error response: error code -32603: Signer had insufficient balance`

This error happens when you don't have enough balance to deploy your contract. You can check your balance with the following command:

```shell
cast wallet address --account monad-deployer
```

### I have constructor arguments, how do I deploy my contract?

```shell
forge create \
  src/Counter.sol:Counter \
  --account monad-deployer \
  --broadcast \
  --constructor-args <constructor_arguments>
```

### I have constructor arguments, how do I verify my contract?

```shell
forge verify-contract \
  <contract_address> \
  src/Counter.sol:Counter \
  --chain 10143 \
  --verifier sourcify \
  --verifier-url https://sourcify-api-monad.blockvision.org \
  --constructor-args <abi_encoded_constructor_arguments>
```

Please refer to the [Foundry Book](https://book.getfoundry.sh/) for more information.
