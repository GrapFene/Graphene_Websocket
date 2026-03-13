FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Expose default WS port
EXPOSE 4000

# Start server (runs 'node dist/server.js')
CMD ["npm", "start"]
