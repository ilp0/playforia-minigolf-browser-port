# syntax=docker/dockerfile:1
#
# Single-image deployment for the TypeScript port: Node WS server
# (port 4242) that also serves the built web bundle.
#
# Build context is the repository root, because port/scripts/prepare-assets.mjs
# pulls images, sounds, l10n, icons, and tracks from the original Java
# resource trees under client/ and server/.

FROM node:22-alpine AS build
WORKDIR /repo

# Only the Java resource subtrees that prepare-assets.mjs reads.
# Keeping these copies narrow avoids dragging the Maven build context in.
COPY client/src/main/resources/picture/agolf ./client/src/main/resources/picture/agolf
COPY client/src/main/resources/sound/shared ./client/src/main/resources/sound/shared
COPY client/src/main/resources/l10n ./client/src/main/resources/l10n
COPY client/src/main/resources/icons/playforia.png ./client/src/main/resources/icons/playforia.png
COPY server/src/main/resources/tracks ./server/src/main/resources/tracks

# Port workspace (shared / server / web).
COPY port ./port

WORKDIR /repo/port
RUN npm ci
RUN node scripts/prepare-assets.mjs
RUN npm run build

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine
WORKDIR /app

# Layout below mirrors what server/src/main.ts expects at runtime:
#   defaultTracksDir = <main.js dir>/../tracks   -> /app/server/tracks
#   webDist          = tracksDir/../../web/dist  -> /app/web/dist
COPY --from=build /repo/port/package.json        ./package.json
COPY --from=build /repo/port/package-lock.json   ./package-lock.json
COPY --from=build /repo/port/node_modules        ./node_modules
COPY --from=build /repo/port/shared/package.json ./shared/package.json
COPY --from=build /repo/port/shared/dist         ./shared/dist
COPY --from=build /repo/port/server/package.json ./server/package.json
COPY --from=build /repo/port/server/src          ./server/src
COPY --from=build /repo/port/server/tracks       ./server/tracks
COPY --from=build /repo/port/web/package.json    ./web/package.json
COPY --from=build /repo/port/web/dist            ./web/dist

ENV NODE_ENV=production
EXPOSE 4242
WORKDIR /app/server

# Server's tsconfig uses noEmit, so we run TypeScript sources directly via
# Node's --experimental-strip-types. Matches the dev script.
CMD ["node", "--experimental-strip-types", "--no-warnings", "src/main.ts", "--host", "0.0.0.0", "--port", "4242"]
