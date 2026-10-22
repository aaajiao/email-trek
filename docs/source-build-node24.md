# Source installation on Node 24

Use Node **24.22.1** and Yarn Classic **1.22.22**. `yarn.lock` is the canonical dependency lock. The production-only frozen installation was verified from a fresh source copy:

```sh
yarn install --production=true --frozen-lockfile --ignore-optional --non-interactive
```

No dependency or lockfile changes are needed for this route. Do not use the historical package-lock.json as a second authority; remove it when adopting the Yarn route. The source has no front-end compilation step. Keep private config.js, Mongo data, SMTP credentials, maintenance-state and logs outside Git. `yarn start` starts the real application, so do not use it as a build test with live SMTP/DB configuration.

`pinyin@2.9.1` declares nodejieba as optional. The existing generator uses its default, non-segmenting conversion paths, so the unused native addon is deliberately omitted rather than compiled or upgraded. A local, network-disabled probe exercised pinyin and generated 1000 synthetic addresses successfully; no addresses were printed and no SMTP or database connection was made. Socket.IO, Express, MongoDB driver, and Nodemailer major versions remain unchanged.

The separate application fixture suite must exercise routes, statistics, quotas, mail result semantics and export behavior with mocked SMTP/DB. A successful dependency installation does not verify live email delivery or the production process manager. Linux container/PM2 startup and site checks remain distinct deployment validation.

The official macOS arm64 Node24.22.1 archive was verified against Node's published SHA256. This installation establishes runtime compatibility; it is not a complete vulnerability audit of all legacy dependencies.
