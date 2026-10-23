FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
WORKDIR /opt/verifier
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund && npm cache clean --force
COPY verify-data.js copy-data.js ./
ENV NODE_OPTIONS=--max-old-space-size=192
USER node
ENTRYPOINT ["node", "/opt/verifier/verify-data.js"]
