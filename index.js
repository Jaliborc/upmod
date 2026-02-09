const process = require('process')
process.removeAllListeners('warning')

const { spawnSync } = require('child_process')
const archiver = require('archiver')
const klaw = require('klaw-sync')

const _ = require('lodash')
const b = require('bluebird')
const chalk = require('chalk')

const fsreplace = require('replace-in-file')
const request = require('request-promise')
const fs = require('fs-extra')
const path = require('path')
const os = require('os')


// Public
function list(dir) {
	return _
		.chain(fs.readdirSync(dir, {withFileTypes: true}))
		.each(i => i.path = path.join(dir, i.name, 'Interface', 'Addons'))
			.filter(i => i.name.match(/^_.+_$/) && exists(i.path))
			.each(i => i.mods = _
			.chain(fs.readdirSync(i.path))
			.filter(mod => exists(path.join(i.path, mod, '.upconfig')))
			.map(mod => ({name: mod, path: path.join(i.path, mod)}))
			.value())
		.value()
}

async function make(params) {
	let upconfig = readconfig(path.join(params.path, '.upconfig'))
	if (!upconfig)
		throw chalk`No {red .upconfig} found`

	let folders = _.concat(_.map(upconfig.modules || [], m => path.join(params.path, '../', m)), params.path)
	for (var folder of folders)
		if (!exists(folder))
			throw chalk`Missing a required module at {red ${folder}}`

	if (!params.stay)
		updateSubmodules(folders)

	let logfile = path.join(params.path, 'Changelog.md')
	if (!exists(logfile))
		throw chalk`No {red Changelog.md} found`

	let changes = params.log?.replace(/\\|\/|\/n/g, '\n')
	let log = changes ? `${changes}\n\n${read(logfile)}` : read(logfile)
	if (changes)
		await fs.writeFile(logfile, log, 'utf8')

	let title = log.match(/^[^\n\r\d]*(\d+(?:\.\d+)?(?:\.\d+)?)(?:\s*\((beta)\))?/)
	if (!title)
		throw chalk`Invalid {red Changelog.md} format`

	let year = (new Date()).getFullYear()
	let version = title[1], type = title[2] || 'release'
	let patrons = _
		.chain(params.patrons || []).each(parsePatron)
		.filter(p => p['Patron Status'] == 'Active patron' && p.Tier && p.Tier != 'Mankrik\'s Wife' && p.Lifetime > 0 && p.Pledge >= 5)
		.sortBy('Lifetime').reverse()
		.groupBy('Tier').toPairs()
		.sortBy(tier => _.meanBy(tier[1], 'Pledge')).reverse()
		.reduce((t, tier) => t + `{title='${tier[0]}',people={` + _.reduce(tier[1], (t, p) => t + `'${capitalize(p.Name)}',`, '').slice(0,-1) + '}},', '')
		.value().slice(0,-1)

	let incompatible = upconfig.incompatible?.filter(v => v.length > 0).map(v => `^${v.replace(/x/g, '\\d+')}$`) || []
	let compatible = params.patches.filter(p => !_.some(incompatible, i => p.name.match(i)))

	let files = _.flatMap(folders, folder => _.map(klaw(folder), i => i.path)).filter(file => !/\\\./g.test(file))
	let dir = path.join(params.path, '../')

	await fs.writeFile(logfile, log, 'utf8')
	await b.each(files, async file => {
		if (file.endsWith('.lua')) {
			await fsreplace({files: file, from: /(local\s+\S+\s*=\s*)[^\n\r]+(\-\-\s*generated\s*patron\s*list)/g, to: `$1{${patrons}} $2`})
			await fsreplace({files: file, from: /(Copyright[^\n\r\t\d]+\d+\s*\-\s*)\d+/g, to: `$1${year}`})
		} else if (file.endsWith('.toc')) {
			let isRoot = folders.includes(path.dirname(file))
			let interfaces = isRoot ? compatible : params.patches

			let matches = interfaces.filter(patch => file.slice(0, -4).toLowerCase().endsWith(patch.flavor.toLowerCase()))
			matches = matches.length > 0 ? matches : interfaces

			await fsreplace({files: file, from: /(##\s*Interface:)\s*([^\n\r\t]+)/, to: `$1 ${_.map(matches, 'toc').join(', ')}`})
			await fsreplace({files: file, from: /(##\s*Version:\s*).*$/m, to: `$1${version}${type !== 'release' ? ' ('+type+')' : ''}`})
		}
	})

	if (!params.stay)
		commitSubmodules(folders, 'Automated year/interface number update')

	let zip = archiver('zip')
	let out = path.join(os.homedir(), 'Desktop', `${params.name}-${version}.zip`)
	let ignore = require('ignore')().add(upconfig.ignore && upconfig.ignore.join('\n'))

	await zip.pipe(fs.createWriteStream(out))
	await b.each(files, async file => {
		let ext = path.extname(file)
		let fout = {name: path.relative(dir, file)}
		let ignored = ignore.ignores(path.relative(dir, file))

		if (ext == '.lua') {
			zip.append(ignored ? 'if true then return end' : fs.createReadStream(file), fout)
		} else if (ext == '.xml') {
			zip.append(ignored ? '<Ui></Ui>' : fs.createReadStream(file), fout)
		} else if (ext == '.tga' || ext == '.mp3') {
			if (!ignored) zip.append(fs.createReadStream(file), fout)
		} else if (ext == '.toc') {
			if (!ignored && folders.includes(path.dirname(file)))
				zip.append(fs.readFileSync(file, 'utf8').replace(/(##\s*Title:\s*)\|c\w{8}(.+)\|r\s*(\r\n?|\n)/, '$1$2$3'), fout)
		}
	}).then(() => zip.finalize())

	let id = upconfig.project && _.find(upconfig.project)
	return {project: id, version: version, patches: compatible, type: type, log: log, file: out}
}

async function upload(params) {
	let headers =  {'User-Agent': 'UpMod/2.0.0', 'X-Api-Token': params.curse}
	let clients = await request.get({url: 'https://wow.curseforge.com/api/game/versions', headers: headers, json: true})
	let compatible = _.filter(clients, c => _.some(params.patches || [], p => p.name == c.name))
	if (compatible.length < params.patches.length)
		throw chalk`Only ${compatible.length} compatible WoW patches found`

	let published = await request.post({
		url:`https://wow.curseforge.com/api/projects/${params.project}/upload-file`,
		headers: headers,
		formData: {
		file: fs.createReadStream(params.file),
		metadata : JSON.stringify({
			gameVersions: _.map(compatible, 'id'),
			displayName: params.version,
			releaseType: params.type,
			changelog: params.log,
			changelogType: 'markdown',
		})
		}
	})

	if (published)
		commitChanges(params.path, params.version)
	return published
}


// Git
function updateSubmodules(folders) {
	for (let folder of folders) {
		if (exists(path.join(folder, '.git'))) {
			let pull = spawnSync('git', ['pull'], {cwd: folder, stdio: 'inherit'})
			if (pull.status !== 0)
				throw chalk`Failed to pull {red ${folder}} from remote`

			let update = spawnSync('git', ['submodule', 'update', '--remote', '--recursive'], {cwd: folder, stdio: 'inherit'})
			if (update.status !== 0)
				throw chalk`Failed to update submodule in {red ${folder}}`
		}
	}
}

function commitSubmodules(folders, message) {
	for (let folder of folders)
		if (exists(path.join(folder, '.git')))
			for (let repo of getSubmodules(folder))
				commitChanges(repo, message)
}

function commitChanges(repo, message) {
	let status = spawnSync('git', ['status', '--porcelain'], {cwd: repo, encoding: 'utf8'})
	if (status?.stdout?.trim().length > 0) {
		console.log('add')
		spawnSync('git', ['add', '.'], {cwd: repo})
		console.log('commit')
		spawnSync('git', ['commit', '-m', message], {cwd: repo, stdio: 'inherit'})
		console.log('push')
		spawnSync('git', ['push', 'origin'], {cwd: repo, stdio: 'inherit'})
	}
}

function getSubmodules(folder) {
	let modules = spawnSync('git', ['submodule', '--quiet', 'foreach', 'echo $displaypath'], {cwd: folder, encoding: 'utf8'})
	if (modules.status !== 0)
		throw chalk`Failed to find submodules in {red ${folder}}`

	return modules.stdout.split('\n').map(s => s.trim()).filter(Boolean).map(s => path.join(folder, s))
}


// Utils
function readconfig(path) {
	let text = read(path)
	let data = {}

	if (text) {
		let key

		for (let line of text.split('\n')) {
		let v = line.match(/^\s*\[(\w+)\]\s*$/)
		if (v) {
			key = v[1]
			data[key] = []
		} else if (key) {
			data[key].push(line.trim())
		}
		}
	}

	return data
}

function exists(file) {
	return fs.existsSync(file) && file
}

function read(file) {
	return fs.existsSync(file) && fs.readFileSync(file, 'utf8')
}

function capitalize(text) {
	return text.split(' ').map(s => s.charAt(0).toUpperCase() + s.substring(1).toLowerCase()).join(' ').substring(0, 17).replace(/'/g, "\\'")
}

function parsePatron(entry) {
	parseDollars(entry, 'Pledge')
	parseDollars(entry, 'Lifetime')
}

function parseDollars(entry, key) {
	entry[key] = parseInt(entry[key + ' Amount'].match(/\d+/)[0])
}

module.exports = {list: list, make: make, upload: upload}
