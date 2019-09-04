const _ = require('lodash')
const b = require('bluebird')
const fs = require('fs-extra')
const path = require('path')

const fsreplace = require('replace-in-file')
const request = require('request-promise')
const chalk = require('chalk')

async function make(options) {
  let patrons = _
    .chain(options.patrons || []).each(parsePatron)
    .filter(p => p['Patron Status'] == 'Active patron' && p.Tier != '' && p.Lifetime > 0 && p.Pledge >= 5)
    .sortBy('Lifetime').reverse()
    .groupBy('Tier').toPairs()
    .sortBy(tier => _.meanBy(tier[1], 'Pledge')).reverse()
    .reduce((t, tier) => t + `{title='${tier[0]}',people={` + _.reduce(tier[1], (t, p) => t + `'${capitalize(p.Name)}',`, '').slice(0,-1) + '}},{},', '')
    .value().slice(0,-4)

  let folders = _.map(options.folders, f => path.join(options.dir, f))
  let logfile = _.find(await b.map(folders, async f => await check(path.join(f, 'Changelog.md'))))
  if (!logfile)
    throw chalk`No {red Changelog.md} found`

  let log = (options.changes || (l => l))(await read(logfile))
  let name = log.match(/^[^\n\r\d]*(\d+(?:\.\d+)?(?:\.\d+)?)(?:\s*\((beta)\))?/)
  if (!name)
    throw chalk`Invalid {red Changelog.md} format`

  let version = name[1], type = name[2] || 'release'
  let out = path.join(require('os').homedir(), 'Desktop', `${options.name}-${version}.zip`)
  let year = (new Date()).getFullYear()
  let zip = require('archiver')('zip')

  await fs.writeFile(logfile, log, 'utf8')
  await zip.pipe(fs.createWriteStream(out))
  await b.each(folders, async folder => {
     let ignore = require('ignore')().add(await read(path.join(folder, '.upignore')) || '')
     let files = _.map(require('klaw-sync')(folder), i => i.path)

     await b.each(files, async file => {
       let ext = path.extname(file)
       let fout = {name: path.relative(options.dir, file)}
       let ignored = ignore.ignores(path.relative(folder, file))

       if (ext == '.lua') {
         await fsreplace({files: file, from: /(local\s+\S+\s*=\s*)[^\n\r]+(\-\-\s*generated\s*patron\s*list)/g, to: `$1{${patrons}} $2`})
         await fsreplace({files: file, from: /(Copyright[^\n\r\t\d]+\d+\s*\-\s*)\d+/g, to: `$1${year}`})
         zip.append(ignored && 'if true then return end' || fs.createReadStream(file), fout)
       } else if (ext == '.xml') {
         zip.append(ignored && '<Ui></Ui>' || fs.createReadStream(file), fout)
       } else if (ext == '.toc') {
         await fsreplace({files: file, from: /(##\s*Version:\s*)[\.\d]+/, to: `$1${version}`})
         await fsreplace({files: file, from: /(##\s*Interface:\s*)\d+/, to: `$1${options.toc}`})
         if (!ignored) zip.append(fs.readFileSync(file, 'utf8').replace(/(##\s*Title:\s*)\|c\w{8}([^|]+)\|r/, '$1$2'), fout)
       } else if (ext == '.tga') {
         if (!ignored) zip.append(fs.createReadStream(file), fout)
       }
     })
  }).then(() => zip.finalize())

  return {path: out, version: version, type: type, log: log}
}

async function check(file) {
  return await fs.pathExists(file) && file
}

async function read(file) {
  return await fs.pathExists(file) && await fs.readFile(file, 'utf8')
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

async function upload(options) {
  let headers =  {'User-Agent': 'UpMod/2.0.0', 'X-Api-Token': options.curse}
  let patches = await request.get({url: 'https://wow.curseforge.com/api/game/versions', headers: headers, json: true})
  let compatible = _.filter(patches, p => _.some(options.patches || [], c => c == p['name']))
  if (compatible.length == 0)
    throw chalk`No valid compatible WoW patch found`

  let page = await request.get(`https://wow.curseforge.com/projects/${options.project}`)
  let project = page.match(/<span>Project ID<\/span>\s*<span>(\d+)<\/span>/)
  if (!project)
    throw chalk`Project ${options.project} does not exist`

  return await request.post({
    url:`https://wow.curseforge.com/api/projects/${project[1]}/upload-file`,
    headers: headers,
    formData: {
      file: fs.createReadStream(options.path),
      metadata : JSON.stringify({
        displayName: options.version,
        releaseType: options.type,
        changelog: options.log,
        gameVersions: _.map(compatible, 'id'),
        changelogType: 'markdown',
      })
    }
  })
}

module.exports = {make: make, upload: upload}
