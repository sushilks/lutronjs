# Build:  docker/build_lutronjs <tag>   (image name and platform come from cfg/build.env)
FROM node:26-alpine AS build
WORKDIR /root/lutronjs
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src src
RUN npm test

FROM node:26-alpine
# Legacy JS configs require('/root/lutronjs/build/loxoneWSUtil'), keep this path.
WORKDIR /root/lutronjs
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# OS patches newer than the base image; npm is only needed to install, drop it afterwards
RUN apk upgrade --no-cache \
    && npm ci --omit=dev && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
              /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=build /root/lutronjs/build build
RUN rm -rf build/test && printf '#!/bin/sh\ncd /root/lutronjs && exec node --enable-source-maps build/lutronServer.js\n' > /root/run_lutronjs.sh \
    && chmod +x /root/run_lutronjs.sh
EXPOSE 8082
CMD ["node", "--enable-source-maps", "build/lutronServer.js"]
