#!/usr/bin/env node

const _ = require('lodash')
const system = require('./index')

const commander = require('commander')
const inquirer = require('inquirer')
const figures = require('figures')
const chalk = require('chalk')

const csv = require('csv-parse/lib/sync')
const fs = require('fs-extra')
const path = require('path')

const config = {}
const savepath = path.join(require('os').homedir(), '.upmod')
const settings = _.map([
	{
		name: 'dir',
		message: 'WoW install directory',
		filter: normalize,
		validate: async dir => {
			let s = await fs.stat(dir).catch(()=>{})
			return s && s.isDirectory() || 'Not a valid directory path'
		},
	},
	{
		name: 'patches',
		message: 'Supported game patch and toc number pairs',
		filter: patches => _.map(patches.split(','), p => {
			let pattern = p.trim().match(/^(\w+)[\/\\](\d+\.\d+\.\d+)[\/\\](\d+)$/)
			return pattern && {flavor: pattern[1], name: pattern[2], toc: pattern[3]}
		}),
		transformer: patches => typeof(patches) != 'string' && _.every(patches) && _.map(patches, p => p.flavor + '/' + p.name + '/' + p.toc).join(', ') || patches,
		validate: patches => _.every(patches) || 'Not in Flavor/X.X.X/TOC, Flavor/X.X.X/TOC format',
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
		.description('display found addons')
		.action( () => {
			for (let install of system.list(config.dir)) {
				print(chalk`{bold {green ℹ} Under ${install.name}:}\n`)

				for (let mod of install.mods.sort())
					print(chalk`❯ {cyan ${mod.name}}\n`)
			}
		})

	commander
		.command('make <modname>')
		.description('build .zip file in desktop')
		.option('-l, --changelog <message>', 'add text into the changelog to name the new build')
		.option('-s, --silent', 'do not update submodules before building')
		.action( (mod, options) => {
			let project = find(mod)
			if (project)
				system.make(Object.assign(options, project, config))
					.then(build => sucess(chalk`Built {cyan ${project.name}} version ${build.version}`))
					.catch(error)
		})

	commander
		.command('up <modname>')
		.description('build and upload given addon to curse')
		.option('-l, --changelog <message>', 'add text into the changelog to name the new build')
		.option('-s, --silent', 'do not update submodules before building')
		.action( (mod, options) => {
			let project = find(mod)
			if (project)
				system.make(Object.assign(options, project, config))
					.then(build => {
						sucess(chalk`Built {cyan ${project.name}} version ${build.version}\n`)
						system.upload(Object.assign(config, build))
							.then(r => sucess(chalk`Uploaded {cyan ${project.name}} version ${build.version}`))
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
			s => ({value: s.name, name: chalk`${s.message} {yellow ─ ${s.transformer(config[s.name])}}`})
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
	let mods = _.flatten(_.map(system.list(config.dir), i => i.mods))
	let match = _.find(mods, entry => clean(entry.name) == clean(mod))
	if (!match)
		error(chalk`{cyan ${mod}} is not registered.`)

	return match
}

function clean(mod) {
	return mod.replace('-', '').replace('_', '').toLowerCase()
}

function normalize(file) {
	return path.normalize(file.trim().replace(/"/g, ''))
}

function sucess(txt) {
	print(chalk`{green ✔} ${txt}`)
}

function error(txt) {
	print(chalk`{red ❯❯} ${txt}`)
}

function print(text) {
	process.stdout.write(figures(text))
}

run()