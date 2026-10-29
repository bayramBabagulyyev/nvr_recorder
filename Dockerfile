# Everything comes from Docker Hub: no apk/apt/npm downloads during the build.
FROM mwader/static-ffmpeg:8.0.1 AS ffmpeg

FROM node:24-alpine
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
ENV DATA_DIR=/data PORT=8080
VOLUME /data
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
