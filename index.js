const _ = require('lodash')
const b = require('bluebird')
const chalk = require('chalk')

const fsreplace = require('replace-in-file')
const request = require('request-promise')
const archiver = require('archiver')
const klaw = require('klaw-sync')
const fs = require('fs-extra')
const path = require('path')
const os = require('os')

function list(dir) {
  return _
    .chain(fs.readdirSync(dir, {withFileTypes: true}))
    .each(i => i.path = path.join(dir, i.name, 'Interface', 'Addons'))
    .filter(i => i.name.match(/^_.+_$/) && check(i.path))
    .each(i => i.mods = _
      .chain(fs.readdirSync(i.path))
      .filter(mod => check(path.join(i.path, mod, '.upconfig')))
      .map(mod => ({name: mod, path: path.join(i.path, mod)}))
      .value()
    )
    .value()
}

async function make(params) {
  let upconfig = readconfig(path.join(params.path, '.upconfig'))
  let incompatible = upconfig.incompatible ? upconfig.incompatible.filter(i => i.length > 0).map(i => i.replace(/x/g, '\\d+')) : []
  let ignore = require('ignore')().add(upconfig.ignore && upconfig.ignore.join('\n'))
  let id = upconfig.project && _.find(upconfig.project)

  let folders = _.concat(_.map(upconfig.modules || [], m => path.join(params.path, '../', m)), params.path)
  for (var folder of folders)
    if (!check(folder))
      throw chalk`Missing a required module at {red ${folder}}`

  let logfile = path.join(params.path, 'Changelog.md')
  if (!check(logfile))
    throw chalk`No {red Changelog.md} found`

  let log = (params.changes || (l => l))(read(logfile))
  let name = log.match(/^[^\n\r\d]*(\d+(?:\.\d+)?(?:\.\d+)?)(?:\s*\((beta)\))?/)
  if (!name)
    throw chalk`Invalid {red Changelog.md} format`

  let year = (new Date()).getFullYear()
  let version = name[1], type = name[2] || 'release'
  let patches = params.patches.filter(p => !_.some(incompatible, i => p.name.match(i)))
  let patrons = _
    .chain(params.patrons || []).each(parsePatron)
    .filter(p => p['Patron Status'] == 'Active patron' && p.Tier != '' && p.Lifetime > 0 && p.Pledge >= 5)
    .sortBy('Lifetime').reverse()
    .groupBy('Tier').toPairs()
    .sortBy(tier => _.meanBy(tier[1], 'Pledge')).reverse()
    .reduce((t, tier) => t + `{title='${tier[0]}',people={` + _.reduce(tier[1], (t, p) => t + `'${capitalize(p.Name)}',`, '').slice(0,-1) + '}},{},', '')
    .value().slice(0,-4)

  let builds = await b.mapSeries(patches, async patch => {
    let out = path.join(os.homedir(), 'Desktop', `${params.name}-${version}-${patch.name}.zip`)
    let zip = archiver('zip')

    await fs.writeFile(logfile, log, 'utf8')
    await zip.pipe(fs.createWriteStream(out))
    await b.each(folders, async folder => {
       let files = _.map(klaw(folder), i => i.path)
       let dir = path.join(folder, '../')

       await b.each(files, async file => {
         let ext = path.extname(file)
         let fout = {name: path.relative(dir, file)}
         let ignored = ignore.ignores(path.relative(folder, file))

         if (ext == '.lua') {
           await fsreplace({files: file, from: /(local\s+\S+\s*=\s*)[^\n\r]+(\-\-\s*generated\s*patron\s*list)/g, to: `$1{${patrons}} $2`})
           await fsreplace({files: file, from: /(Copyright[^\n\r\t\d]+\d+\s*\-\s*)\d+/g, to: `$1${year}`})
           zip.append(ignored && 'if true then return end' || fs.createReadStream(file), fout)
         } else if (ext == '.xml') {
           zip.append(ignored && '<Ui></Ui>' || fs.createReadStream(file), fout)
         } else if (ext == '.toc') {
           await fsreplace({files: file, from: /(##\s*Version:\s*)[\.\d]+/, to: `$1${version}`})
           await fsreplace({files: file, from: /(##\s*Interface:\s*)\d+/, to: `$1${patch.id}`})
           if (!ignored) zip.append(fs.readFileSync(file, 'utf8').replace(/(##\s*Title:\s*)\|c\w{8}([^|]+)\|r/, '$1$2'), fout)
         } else if (ext == '.tga') {
           if (!ignored) zip.append(fs.createReadStream(file), fout)
         }
       })
    }).then(() => zip.finalize())

    return {path: out, patch: patch}
  })

  return {project: id, version: version, type: type, log: log, builds: builds}
}

function readconfig(file) {
  let text = read(file)
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

function check(file) {
  return fs.existsSync(file) && file
}

function read(file) {
  return fs.existsSync(file) && fs.readFileSync(file, 'utf8')
}

function capitalize(text) {
  return text.split(' ').map(s => s.charAt(0).toUpperCase() + s.substring(1)).join(' ')
}

function parsePatron(entry, key) {
  parseDollars(entry, 'Pledge')
  parseDollars(entry, 'Lifetime')
}

function parseDollars(entry, key) {
  entry[key] = parseInt(entry[key + ' $'].match(/\d+/)[0])
}

async function upload(params) {
  let headers =  {'User-Agent': 'UpMod/2.0.0', 'X-Api-Token': params.curse}
  let patches = await request.get({url: 'https://wow.curseforge.com/api/game/versions', headers: headers, json: true})
  let compatible = _.filter(patches, p => _.some(params.builds || [], b => b.patch.name == p.name))
  if (compatible.length < params.builds.length)
    throw chalk`Only ${compatible.length} compatible WoW patches found`

  return await b.map(params.builds, async build =>
    await request.post({
      url:`https://wow.curseforge.com/api/projects/${params.project}/upload-file`,
      headers: headers,
      formData: {
        file: fs.createReadStream(build.path),
        metadata : JSON.stringify({
          displayName: params.version,
          releaseType: params.type,
          changelog: params.log,
          gameVersions: [_.find(patches, p => p.name == build.patch.name).id],
          changelogType: 'markdown',
        })
      }
    })
  )
}

module.exports = {list: list, make: make, upload: upload}
