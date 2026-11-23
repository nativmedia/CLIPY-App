FROM node:24-bookworm-slim AS web-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/
RUN npm ci
COPY web/ web/
RUN npm run build --workspace web

FROM python:3.12-slim-bookworm
COPY --from=web-build /usr/local/bin/node /usr/local/bin/node
COPY --from=web-build /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && apt-get update \
    && apt-get install -y --no-install-recommends chromium ffmpeg fonts-liberation libgl1 libportaudio2 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home clipy

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PATH="/app/server/.venv/bin:$PATH" \
    CLIPY_WHISPER_DEVICE=cpu \
    HF_HOME=/home/clipy/.cache/huggingface \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY scripts/setup.mjs scripts/
COPY server/requirements.txt server/
RUN node scripts/setup.mjs

COPY hyperframes-renderer/package.json hyperframes-renderer/package-lock.json hyperframes-renderer/
RUN npm ci --omit=dev --prefix hyperframes-renderer
COPY hyperframes-renderer/effects.js hyperframes-renderer/

COPY server/app.py server/docker_app.py server/
COPY server/clipy/ server/clipy/
COPY --from=web-build /app/web/dist/ web/dist/
# The renderer uses the same fonts that the web build ships for previews.
RUN mkdir -p web/public \
    && ln -s ../dist/fonts web/public/fonts \
    && install -d -o clipy -g clipy /app/server/data /home/clipy/.cache/huggingface

USER clipy
WORKDIR /app/server
EXPOSE 4747
CMD ["python", "-m", "uvicorn", "docker_app:app", "--host", "0.0.0.0", "--port", "4747", "--no-proxy-headers"]
