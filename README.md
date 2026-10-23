# email-trek

<pre style="text-align: left;margin-top: 0px;margin-bottom: 200px">                 ____                               ___
                /\  _`\                         __ /\_ \
                \ \ \L\_\    ___ ___      __   /\_\\//\ \
                 \ \  _\L  /' __` __`\  /'__`\ \/\ \ \ \ \
                  \ \ \L\ \/\ \/\ \/\ \/\ \L\.\_\ \ \ \_\ \_
                   \ \____/\ \_\ \_\ \_\ \__/.\_\\ \_\/\____\
                    \/___/  \/_/\/_/\/_/\/__/\/_/ \/_/\/____/


                        ______             __
                       /\__  _\           /\ \
                       \/_/\ \/ _ __    __\ \ \/'\
                          \ \ \/\`'__\/'__`\ \ , &lt;
                           \ \ \ \ \//\  __/\ \ \\`\
                            \ \_\ \_\\ \____\\ \_\ \_\
                             \/_/\/_/ \/____/ \/_/\/_/

 README

   Email Trek is derived from the concept of Star Trek, we assume that the
   email system is destroyed (more exactly and loss associated with human).

   We construct a system can be randomly generated email, and will
   automatically send mail, through this email we will get four state:

     ▞▚ Delivery    ▒▒ Sent    ▓▓ Failure  ██ Open

   We construct a system can be randomly generated email, and will
   automatically send mail, through this email we will get four kinds of
   state: we will record these states, drawing into our own star coordinates.

 CONTACT

   If you have problems, questions, ideas or suggestions, please contact us
   by posting to a suitable email. See http://eventstructure.com/email

   All contributors to the project are listed : Quanquan (code).

 WEB SITE

   Visit the curl web site for the latest news and update:

         * http://eventstructure.com/email-trek/
         http://email-trek.t-h-e-s-p-a-c-e.com/

 GIT

   To download the latest source off the GIT server do this:

     git clone https://github.com/aaajiao/email-trek

   (you'll get a directory named email-trek created, filled with the source
   code)

 NOTICE

   Email Trek contains pieces of source code that is Copyright (c) 2015, 2016
   eventstructure. This notice is included here to comply with the distribution
   terms.

</pre>

## Current version

[Visit Email Trek](https://email-trek.t-h-e-s-p-a-c-e.com/). The original description above remains part of the artwork.

- **Explore:** opening the homepage starts random address exploration and masked scrolling. Exploration pauses when the last visitor leaves.
- **Mail You:** visitors can explicitly submit an address to receive a message, subject to delivery limits.
- **SVG:** export up to 100,000 recent records with their **complete stored email addresses**, preserving the original visual layout. These exports are public by design.

Automatic message delivery to randomly generated addresses is paused; `AUTO_SEND` is off. This limited operating mode does not reproduce the complete original automatic-sending mechanism.

`VERIFIED` records an SMTP recipient-acceptance response, not proof that a mailbox exists or received mail. `SENT` means the sending provider accepted a message, not that it reached an inbox or was opened. Recent records are bounded at 100,000; cumulative totals remain preserved.

## Run

Use Node 24 and Yarn 1. Create a private `config.js` from `config.example.js` and provide the environment variables listed in `.env.example`. Follow the [setup guide](docs/source-build-node24.md) to configure MongoDB and persistent state; run one application process.

```sh
yarn install --frozen-lockfile --ignore-optional
yarn test
yarn start
```

See [delivery limits](docs/paced-sending.md), [storage and database compatibility](docs/mongodb-driver.md), and [operations](ops/) for details. Keep credentials, database files and generated exports outside Git.
