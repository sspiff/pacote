const Fetcher = require('./fetcher.js')
const FileFetcher = require('./file.js')
const RemoteFetcher = require('./remote.js')
const DirFetcher = require('./dir.js')
const hashre = /^[a-f0-9]{40}$/
const git = require('./util/git/')
const pickManifest = require('npm-pick-manifest')
const npa = require('npm-package-arg')
const url = require('url')
const Minipass = require('minipass')
const cacache = require('cacache')
const { promisify } = require('util')
const readPackageJson = require('read-package-json-fast')
const npm = require('./util/npm.js')

const _resolvedFromRepo = Symbol('_resolvedFromRepo')
const _resolvedFromHosted = Symbol('_resolvedFromHosted')
const _resolvedFromClone = Symbol('_resolvedFromClone')
const _tarballFromResolved = Symbol.for('pacote.Fetcher._tarballFromResolved')
const _addGitSha = Symbol('_addGitSha')
const _clone = Symbol('_clone')
const _cloneHosted = Symbol('_cloneHosted')
const _cloneRepo = Symbol('_cloneRepo')
const _setResolvedWithSha = Symbol('_setResolvedWithSha')
const _prepareDir = Symbol('_prepareDir')

// get the repository url.  prefer ssh, fall back to git://
// We have to add the git+ back because npa suppresses it.
const repoUrl = (hosted, opts) =>
  hosted.sshurl && addGitPlus(hosted.sshurl(opts)) ||
  hosted.https && addGitPlus(hosted.https(opts))

const addGitPlus = url => url && `git+${url}`

class GitFetcher extends Fetcher {
  constructor (spec, opts) {
    super(spec, opts)
    this.resolvedRef = null
    if (this.spec.hosted)
      this.from = this.spec.hosted.shortcut({ noCommittish: false })

    // shortcut: avoid full clone when we can go straight to the tgz
    // if we have the full sha and it's a hosted git platform
    if (this.spec.gitCommittish && hashre.test(this.spec.gitCommittish)) {
      this.resolvedSha = this.spec.gitCommittish
      // use hosted.tarball() when we shell to RemoteFetcher later
      this.resolved = this.spec.hosted
        ? repoUrl(this.spec.hosted, { noCommittish: false })
        : this.spec.fetchSpec + '#' + this.spec.gitCommittish
    } else
      this.resolvedSha = ''
  }

  get types () {
    return ['git']
  }

  resolve () {
    // likely a hosted git repo with a sha, so get the tarball url
    // but in general, no reason to resolve() more than necessary!
    if (this.resolved)
      return super.resolve()

    // fetch the git repo and then look at the current hash
    const h = this.spec.hosted
    // try to use ssh, fall back to git.
    return h ? this[_resolvedFromHosted](h)
      : this[_resolvedFromRepo](this.spec.fetchSpec)
  }

  // first try https, since that's faster and passphrase-less for
  // public repos.  Fall back to SSH to support private repos.
  // NB: we always store the SSH url in the 'resolved' field.
  [_resolvedFromHosted] (hosted) {
    return this[_resolvedFromRepo](hosted.https && hosted.https())
      .catch(er => {
        const ssh = hosted.sshurl && hosted.sshurl()
        if (!ssh)
          throw er
        return this[_resolvedFromRepo](ssh)
      })
  }

  [_resolvedFromRepo] (gitRemote) {
    // XXX make this a custom error class
    if (!gitRemote)
      return Promise.reject(new Error(`No git url for ${this.spec}`))
    const gitRange = this.spec.gitRange
    const name = this.spec.name
    return git.revs(gitRemote, this.opts).then(remoteRefs => {
      return gitRange ? pickManifest({
          versions: remoteRefs.versions,
          'dist-tags': remoteRefs['dist-tags'],
          name,
        }, gitRange, this.opts)
        : this.spec.gitCommittish ?
          remoteRefs.refs[this.spec.gitCommittish] ||
          remoteRefs.refs[remoteRefs.shas[this.spec.gitCommittish]]
        : remoteRefs.refs.HEAD // no git committish, get default head
    }).then(revDoc => {
      // the committish provided isn't in the rev list
      // things like HEAD~3 or @yesterday can land here.
      if (!revDoc || !revDoc.sha)
        return this[_resolvedFromClone]()

      this.resolvedRef = revDoc
      this.resolvedSha = revDoc.sha
      this[_addGitSha](revDoc.sha)
      return this.resolved
    })
  }

  [_setResolvedWithSha] (withSha) {
    // we haven't cloned, so a tgz download is still faster
    // of course, if it's not a known host, we can't do that.
    this.resolved = !this.spec.hosted ? withSha
      : repoUrl(npa(withSha).hosted, { noCommittish: false })
  }

  // when we get the git sha, we affix it to our spec to build up
  // either a git url with a hash, or a tarball download URL
  [_addGitSha] (sha) {
    if (this.spec.hosted) {
      this[_setResolvedWithSha](
        this.spec.hosted.shortcut({ noCommittish: true }) + '#' + sha
      )
    } else {
      const u = url.parse(this.spec.rawSpec)
      u.hash = '#' + sha
      delete u.href
      this[_setResolvedWithSha](url.format(u))
    }
  }

  [_resolvedFromClone] () {
    // do a full or shallow clone, then look at the HEAD
    // kind of wasteful, but no other option, really
    return this[_clone](dir => this.resolved)
  }

  [_prepareDir] (dir) {
    return readPackageJson(dir + '/package.json').then(mani => {
      // no need if we aren't going to do any preparation.
      const scripts = mani.scripts
      if (!scripts || !(
          scripts.postinstall ||
          scripts.build ||
          scripts.preinstall ||
          scripts.install ||
          scripts.prepare))
        return

      // the DirFetcher will do its own preparation to run the prepare scripts
      // All we have to do is put the deps in place so that it can succeed.
      return npm(
        this.npmBin,
        [].concat(this.npmInstallCmd).concat(this.npmCliConfig),
        dir,
        'git dep preparation failed'
      )
    })
  }

  [_tarballFromResolved] () {
    const stream = new Minipass()
    stream.resolved = this.resolved
    stream.integrity = this.integrity
    stream.from = this.from

    // check it out and then shell out to the DirFetcher tarball packer
    this[_clone](dir => this[_prepareDir](dir)
      .then(() => new Promise((res, rej) => {
        const df = new DirFetcher(`file:${dir}`, {
          ...this.opts,
          resolved: null,
          integrity: null,
        })
        const dirStream = df[_tarballFromResolved]()
        dirStream.on('error', rej)
        dirStream.on('end', res)
        dirStream.pipe(stream)
      }))).catch(
        /* istanbul ignore next: very unlikely and hard to test */
        er => stream.emit('error', er)
      )
    return stream
  }

  // clone a git repo into a temp folder (or fetch and unpack if possible)
  // handler accepts a directory, and returns a promise that resolves
  // when we're done with it, at which point, cacache deletes it
  //
  // TODO: after cloning, create a tarball of the folder, and add to the cache
  // with cacache.put.stream(), using a key that's deterministic based on the
  // spec and repo, so that we don't ever clone the same thing multiple times.
  [_clone] (handler, tarballOk = true) {
    const o = { tmpPrefix: 'git-clone' }
    const ref = this.resolvedSha || this.spec.gitCommittish
    const h = this.spec.hosted
    const resolved = this.resolved

    // can be set manually to false to fall back to actual git clone
    tarballOk = tarballOk &&
      h && resolved === repoUrl(h, { noCommittish: false }) && h.tarball

    return cacache.tmp.withTmp(this.cache, o, tmp => {
      // if we're resolved, and have a tarball url, shell out to RemoteFetcher
      if (tarballOk) {
        const nameat = this.spec.name ? `${this.spec.name}@` : ''
        return new RemoteFetcher(h.tarball({ noCommittish: false }), {
          ...this.opts,
          pkgid: `git:${nameat}${this.resolved}`,
          resolved: this.resolved,
          integrity: null, // it'll always be different, if we have one
        }).extract(tmp).then(() => handler(tmp), er => {
          // fall back to ssh download if tarball fails
          if (er.constructor.name.match(/^Http/))
            return this[_clone](handler, false)
          else
            throw er
        })
      }

      return (
        h ? this[_cloneHosted](ref, tmp)
        : this[_cloneRepo](this.spec.fetchSpec, ref, tmp)
      ).then(sha => {
        this.resolvedSha = sha
        if (!this.resolved)
          this[_addGitSha](sha)
      })
      .then(() => handler(tmp))
    })
  }

  [_cloneHosted] (ref, tmp) {
    const hosted = this.spec.hosted
    const https = hosted.https()
    return this[_cloneRepo](hosted.https({ noCommittish: true }), ref, tmp)
      .catch(er => {
        const ssh = hosted.sshurl && hosted.sshurl({ noCommittish: true })
        /* istanbul ignore if - should be covered by the resolve() call */
        if (!ssh)
          throw er
        return this[_cloneRepo](ssh, ref, tmp)
      })
  }

  [_cloneRepo] (repo, ref, tmp) {
    return git.clone(repo, ref, tmp, this.spec, this.opts)
  }

  manifest () {
    if (this.package)
      return Promise.resolve(this.package)

    return this.spec.hosted && this.resolved
      ? FileFetcher.prototype.manifest.apply(this)
      : this[_clone](dir =>
          readPackageJson(dir + '/package.json')
            .then(mani => this.package = {
              ...mani,
              _integrity: this.integrity && String(this.integrity),
              _resolved: this.resolved,
              _from: this.from,
            }))
  }

  packument () {
    return FileFetcher.prototype.packument.apply(this)
  }
}
module.exports = GitFetcher
