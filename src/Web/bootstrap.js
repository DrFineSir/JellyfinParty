(() => {
    if (window.__jellyfinPartyBoot) return;
    window.__jellyfinPartyBoot = true;
    const base = new URL('.', document.currentScript.src).href;
    import(base + 'party.js').then(({ boot }) => boot(base)).catch(error => console.error('Jellyfin Party could not start', error));
})();
