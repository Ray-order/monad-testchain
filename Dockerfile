# Use Node.js 18 Alpine image for a small footprint
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install dependencies first to leverage Docker cache
COPY package.json package-lock.json ./
RUN npm install

# Copy the rest of the application code
COPY . .

# Set default environment variables (can be overridden)
ENV RPC_URL=https://testnet-rpc.monad.xyz
ENV POLL_INTERVAL_MS=150

# Default command to run the monitor
CMD ["npm", "run", "monitor:monad"]
