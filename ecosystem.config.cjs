module.exports = {
  apps: [
    {
      name: "zai-claude-proxy",
      script: "proxy.mjs",
      env: {
        ZAI_PROXY_PORT: 3333,
        NODE_ENV: "production",
      },
    },
  ],
};
