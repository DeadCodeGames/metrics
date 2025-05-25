# Base image
FROM node:20-bookworm-slim

# Copy repository
COPY . /metrics
WORKDIR /metrics

# Make action executable
RUN chmod +x /metrics/source/app/action/index.mjs

# Update package lists
RUN apt-get update

# Install wget, gnupg, and certificates needed for adding Google Chrome repository
RUN apt-get install -y wget gnupg ca-certificates libgconf-2-4

# Add Google Chrome repository key
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add -

# Add Google Chrome repository
RUN sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list'

# Update package lists again after adding new repository
RUN apt-get update

# Install Chrome and required fonts
RUN apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 libx11-xcb1 libxtst6 lsb-release libxslt-dev libxml2-dev build-essential jq --no-install-recommends

# Install dependencies for deno
RUN apt-get install -y curl unzip

# Install deno
RUN curl -fsSL https://deno.land/x/install/install.sh | DENO_INSTALL=/usr/local sh

# Install ruby and dependencies for licensed gem
RUN apt-get install -y ruby-full git g++ cmake pkg-config libssl-dev

# Install licensed gem
RUN gem install licensed

# Install python for node-gyp
RUN apt-get install -y python3

# Clean apt cache to reduce image size
RUN rm -rf /var/lib/apt/lists/*

# Install node modules
RUN npm ci

# Build the project
RUN npm run build

# Environment variables
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_BROWSER_PATH=google-chrome-stable

# Execute GitHub action
ENTRYPOINT ["node", "/metrics/source/app/action/index.mjs"]
