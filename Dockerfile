# Match the supported Jellyfin Server/Web release.
ARG JELLYFIN_IMAGE=jellyfin/jellyfin:12.1
FROM ${JELLYFIN_IMAGE} AS jellyfin_base
FROM python:3.12-alpine AS web_patch
COPY --from=jellyfin_base /jellyfin/jellyfin-web /web
COPY scripts/patch-web.py /patch-web.py
RUN python /patch-web.py /web
FROM jellyfin_base
COPY --from=web_patch /web/index.html /jellyfin/jellyfin-web/index.html
COPY --from=web_patch /web/config.json /jellyfin/jellyfin-web/config.json
COPY dist/Jellyfin.Plugin.JellyfinParty.dll /opt/jellyfin-party/Jellyfin.Plugin.JellyfinParty.dll
COPY --chmod=755 scripts/entrypoint.sh /opt/jellyfin-party/entrypoint.sh
ENTRYPOINT ["/opt/jellyfin-party/entrypoint.sh"]
