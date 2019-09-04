#!/usr/bin/env node

const _ = require('lodash')
const system = require('./index')

const commander = require('commander')
const inquirer = require('inquirer')
const chalk = require('chalk')

const csv = require('csv-parse/lib/sync')
const fs = require('fs-extra')
const path = require('path')

const config = {mods: {}}
const savepath = path.join(require('os').homedir(), '.upmod')
const settings = _.map([
  {
    name: 'dir',
    message: 'Mod install directory',
    filter: normalize,
    validate: async dir => {
      let s = await fs.stat(dir).catch(()=>{})
      return s && s.isDirectory() || 'Not a valid directory path'
    },
  },
  {
    name: 'toc',
    message: 'Game toc number',
    validate: toc => parseInt(toc) && true || 'Not a number',
  },
  {
    name: 'patches',
    message: 'Supported game patches',
    filter: patches => _.map(patches.split(','), p => p.trim()),
    validate: patches => _.every(patches, p => p.match(/^\d+\.\d+\.\d+$/)) || 'Not in X.X.X, X.X.X format',
  },
  {
    name: 'curse',
    message: 'Curse login token',
    validate: token => token.length > 5 || 'Too short for correct login token',
  },
  {
    name: 'patrons',
    message: 'Patron list .csv file',
    filter: file => csv(fs.readFileSync(normalize(file), 'utf8'), {delimiter: ',', columns: true}),
    transformer: patrons => typeof(patrons) != 'string' && _.has(patrons, 'length') && `${patrons.length} Patrons` || patrons,
    validate: patrons => patrons.length > 0 || 'Not a valid .csv file',
    optional: true,
  },
], s => Object.assign({type: 'input', filter: v => v.trim(), transformer: v => v}, s))


/* CLI */

async function run() {
  Object.assign(config, await fs.readJson(savepath).catch(() => {}))
  await configure(set => !config[set.name] && !set.optional)

  commander
    .command('config')
    .description('change global settings')
    .action( () => {
      configuration()
    })

  commander
    .command('list')
    .description('display registered addons')
    .action( () => {
      print(chalk`{bold {green ℹ} Registered Mods:}`)
      for (let id of _.keys(config.mods).sort())
        print(chalk`\n❯ {cyan ${id}} {gray ─ ${config.mods[id].length} folders}`)
    })

  commander
    .command('add <modname> <folders...>')
    .description('register addon as a set of folders')
    .action( (mod, folders) => {
      config.mods[mod] = _.map(folders, f => path.basename(normalize(f)))
      sucess(chalk`Registered {cyan ${mod}} {gray ─ ${folders.length} folders}`)
      save()
    })

  commander
    .command('del <modname>')
    .description('remove given addon from the registry')
    .action( mod => {
      let id = find(mod)
      if (id) {
        delete config.mods[id]
        print(chalk`Unregistered {cyan ${id}}`)
        save()
      }
    })

  commander
    .command('make <modname>')
    .description('build .zip file in desktop')
    .option('-p, --patch', 'name new patch build automatically')
    .action( (mod, options) => {
      let id = find(mod)
      if (id)
        system.make(Object.assign({name: id, folders: config.mods[id], changes: options.patch && patchLog}, config))
          .then(build => sucess(chalk`Built {cyan ${id}} version ${build.version}`))
          .catch(error)
    })

  commander
    .command('up <modname>')
    .description('build and upload given addon to curse')
    .option('-p, --patch', 'name new patch build automatically')
    .action( (mod, options) => {
      let id = find(mod)
      if (id)
        system.make(Object.assign({name: id, folders: config.mods[id], changes: options.patch && patchLog}, config))
          .then(build => {
            sucess(chalk`Built {cyan ${id}} version ${build.version}\n`)
            system.upload(Object.assign({project: id}, build, config))
              .then(r => sucess(chalk`Uploaded {cyan ${id}} version ${build.version}`))
              .catch(error)
          })
          .catch(error)
    })

  commander.version('2.0').parse(process.argv)
}

async function configuration() {
  answer = await inquirer.prompt([{
    name: 'setting',
    type: 'list',
    message: 'Choose setting to modify',
    choices: _.map(settings,
      s => ({value: s.name, name: chalk`${s.message} {gray ─ ${s.transformer(config[s.name])}}`})
    ),
  }])

  await configure(s => s.name == answer.setting)
  await configuration()
}

async function configure(what) {
  Object.assign(config, await inquirer.prompt(_.filter(settings, what)))
  await save()
}

async function save() {
  await fs.writeJson(savepath, config)
}


/* Util */

function find(mod) {
  let id
  for (let entry in config.mods)
    if (clean(entry) == clean(mod))
      id = entry

  if (!id)
    error(chalk`{cyan ${mod}} is not registered.`)

  return id
}

function clean(mod) {
  return mod.replace('-', '').replace('_', '').toLowerCase()
}

function normalize(file) {
  return path.normalize(file.trim().replace(/"/g, ''))
}

function patchLog(txt) {
  return `##### ${config.patch}\n* Updated for World of Warcraft patch ${config.patch}.\n\n` + txt
}

function sucess(txt) {
  print(chalk`{green ✔} ${txt}`)
}

function error(txt) {
  print(chalk`{red ❯❯} ${txt}`)
}

function print(text) {
  process.stdout.write(require('figures')(text))
}

run()
