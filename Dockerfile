FROM node:24-alpine
RUN apk add --no-cache ffmpeg tzdata
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV DATA_DIR=/data PORT=8080
VOLUME /data
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
