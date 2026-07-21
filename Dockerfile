# Meeting Notes — zero-dependency image.
# Build:  docker build -t meeting-notes .
# Run:    docker run -p 3000:3000 -v mn-data:/data meeting-notes
#         (mount a host path or named volume at /data to persist encrypted notes)
FROM node:20-alpine

WORKDIR /app
# No dependencies to install — copy the source as-is.
COPY . .

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data

# Encrypted data lives here; declare it a volume so it survives container churn.
VOLUME ["/data"]
EXPOSE 3000

# Run as the built-in non-root user.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
