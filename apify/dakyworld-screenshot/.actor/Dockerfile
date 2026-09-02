# Apify's own Playwright image: Chromium and its system libraries are already
# here, at the build Playwright expects.
#
# **The tag and the `playwright` dependency in package.json must move
# together.** The browsers baked into this image live in a directory named for
# the Playwright version that installed them, so a package.json asking for a
# different version finds no browser at all and every run dies on
# "Executable doesn't exist at /home/myuser/.cache/ms-playwright/chromium-…".
# Pinned rather than `:20`, so a rebuild six months from now runs the same
# browser the screenshots were verified against.
FROM apify/actor-node-playwright-chrome:20-1.49.1

# The manifests first, so editing src/ does not reinstall the world.
COPY --chown=myuser:myuser package*.json ./

# Dev dependencies included because TypeScript is one and the build needs it;
# pruned again below so they do not ship. Optional dependencies are *not*
# omitted — sharp's prebuilt binary is one.
RUN npm install --include=dev --audit=false --fund=false --quiet

COPY --chown=myuser:myuser . ./

RUN npm run build && npm prune --omit=dev

CMD ["npm", "run", "start", "--silent"]
