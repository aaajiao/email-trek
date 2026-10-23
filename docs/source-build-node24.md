# Source installation on Node 24

Use Node **24.22.1** and Yarn Classic **1.22.22**. `yarn.lock` is the canonical dependency lock. The production-only frozen installation was verified from a fresh source copy:

```sh
yarn install --production=true --frozen-lockfile --ignore-optional --non-interactive
```

Use the committed package manifest and matching lockfile together. The MongoDB driver adaptation pins 7.7.0 and updates only its dependency subtree; it is separate from the earlier runtime-only compatibility work. Do not use the historical package-lock.json as a second authority. The source has no front-end compilation step. Keep private config.js, Mongo data, SMTP credentials, maintenance-state and logs outside Git. `yarn start` starts the real application, so do not use it as a build test with live SMTP/DB configuration.

`pinyin@2.9.1` declares nodejieba as optional. The existing generator uses its default, non-segmenting conversion paths, so the unused native addon is deliberately omitted rather than compiled or upgraded. A local, network-disabled probe exercised pinyin and generated 1000 synthetic addresses successfully; no addresses were printed and no SMTP or database connection was made. Socket.IO, Express and Nodemailer remain at their existing lockfile versions. MongoDB driver changes and real-database fixture instructions are documented in [mongodb-driver.md](mongodb-driver.md).

The separate application fixture suite must exercise routes, statistics, quotas, mail result semantics and export behavior with mocked SMTP/DB. A successful dependency installation does not verify live email delivery or the production process manager. Linux container/PM2 startup and site checks remain distinct deployment validation.

The official macOS arm64 Node24.22.1 archive was verified against Node's published SHA256. This installation establishes runtime compatibility; it is not a complete vulnerability audit of all legacy dependencies.
