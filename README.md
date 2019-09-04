# UpMod :package:
[![](https://img.shields.io/npm/v/upmod.svg)](https://www.npmjs.com/package/upmod) [![](https://travis-ci.com/jaliborc/upmod.svg)](https://travis-ci.com/Jaliborc/upmod/) ![](https://david-dm.org/jaliborc/upmod.svg) ![](https://img.shields.io/npm/l/upmod.svg)

Builds and uploads World of Warcraft addons to CurseForge. It supports the following features:
* Build and upload of `.zip` files using a curseforge API key
* `.gitignore` style ignore for upload (called `.upignore`)
    * `.lua` and `.xml` files will be replaced by the simplest file the game client will accept without crashing
* Version name detection from changelogs
    * Automatic `.toc` version update
* `.toc` title color removal, without changing source code (so you can highlight your mods ingame in awful colors locally, without harming users eyeballs)
* Automatic patron list generation into any chosen `.lua` variable
* Automatic copyright years period duration

## CLI Usage
Install using npm:

    npm install -g upmod

Use the help flag to learn how to use it:

    upmod -h

When you first start the command line interface, you will be guided to input the required global configuration. Then, you can use the CLI commands normally as described by the help flag.

## Programmatic Usage
Yes, there is an API to use in node if you really want one.

```js
const upmod = require('upmod')

let build = upmod.make(data)
let result = upmod.upload(build)
``` 
