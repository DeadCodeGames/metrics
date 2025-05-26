//Imports
import fs from "fs/promises"
import os from "os"
import paths from "path"
import git from "simple-git"
import {filters} from "../../../app/metrics/utils.mjs"

/**Analyzer */
export class Analyzer {
  /**Constructor */
  constructor(login, {account = "bypass", authoring = [], uid = Math.random(), shell, rest = null, context = {mode:"user"}, skipped = [], pathsIgnored = [], categories = ["programming", "markup"], timeout = {global:NaN, repositories:NaN}}) {
    //User informations
    this.login = login
    this.account = account
    this.authoring = authoring
    this.uid = uid
    this.gpg = []

    //Utilities
    this.shell = shell
    this.rest = rest
    this.context = context
    this.markers = {
      hash:/\b[0-9a-f]{40}\b/,
      file:/^[+]{3}\sb[/](?<file>[\s\S]+)$/,
      line:/^(?<op>[-+])\s*(?<content>[\s\S]+)$/,
    }
    this.parser = /^(?<login>[\s\S]+?)\/(?<name>[\s\S]+?)(?:@(?<branch>[\s\S]+?)(?::(?<ref>[\s\S]+))?)?$/

    //Options
    this.skipped = skipped
    this.pathsIgnored = pathsIgnored
    this.categories = categories
    this.timeout = timeout
    this.consumed = false

    //Results
    this.results = {partial:{global:false, repositories:false}, total:0, lines:{}, stats:{}, colors:{}, commits:0, files:0, missed:{lines:0, bytes:0, commits:0}, elapsed:0}
    this.debug(`instantiated a new ${this.constructor.name}`)
  }

  /**Run analyzer */
  async run(runner) {
    if (this.consumed)
      throw new Error("This analyzer has already been consumed, another instance needs to be created to perform a new analysis")
    this.consumed = true
    const results = await new Promise(async solve => {
      let completed = false
      if (Number.isFinite(this.timeout.global)) {
        this.debug(`timeout set to ${this.timeout.global}m`)
        setTimeout(() => {
          if (!completed) {
            try {
              this.debug(`reached maximum execution time of ${this.timeout.global}m for analysis`)
              this.results.partial.global = true
              solve(this.results)
            }
            catch {
              //Ignore errors
            }
          }
        }, this.timeout.global * 60 * 1000)
      }
      await runner()
      completed = true
      solve(this.results)
    })
    return results
  }

  /**Parse repository */
  parse(repository) {
    let branch = null, ref = null
    if (typeof repository === "string") {
      if (!this.parser.test(repository))
        throw new TypeError(`"${repository}" pattern is not supported`)
      const {login, name, ...groups} = repository.match(this.parser)?.groups ?? {}
      repository = {owner:{login}, name}
      branch = groups.branch ?? null
      ref = groups.ref ?? null
    }
    const repo = `${repository.owner.login}/${repository.name}`
    const path = paths.join(os.tmpdir(), `${this.uid}-${repo.replace(/[^\w]/g, "_")}`)
    return {repo, path, branch, ref}
  }

  /**Clone a repository */
  async clone(repository) {
    const {repo, branch, path} = this.parse(repository)
    let url = /^https?:\/\//.test(repo) ? repo : `https://github.com/${repo}`
    try {
      this.debug(`cloning https://github.com/${repo} to ${path}`)
      await fs.rm(path, {recursive:true, force:true})
      await fs.mkdir(path, {recursive:true})
      await git(path).clone(url, ".", ["--single-branch"]).status()
      this.debug(`cloned ${url} to ${path}`)
      if (branch) {
        this.debug(`switching to branch ${branch} for ${repo}`)
        await git(path).branch(branch)
      }
      return true
    }
    catch (error) {
      this.debug(`failed to clone ${url} (${error})`)
      this.clean(path)
      return false
    }
  }

  /**Check if path should be ignored */
  shouldIgnorePath(repo, filePath) {
    this.debug(repo, filePath)
    for (const ignoredPath of this.pathsIgnored) {
      //Check for repo:path pattern (using colon as separator)
      if (ignoredPath.includes(":")) {
        const [repoSpec, pathToIgnore] = ignoredPath.split(":", 2)

        //Handle owner/repo:path format
        if (repoSpec.includes("/") && repo.toLowerCase() === repoSpec.toLowerCase()) {
          if (filePath.startsWith(pathToIgnore)) {
            this.debug(`ignoring file ${filePath} in ${repo} as it matches ignored path ${pathToIgnore} (colon format)`)
            return true
          }
        }
        //Handle repo:path format (current repo)
        else if (repo.endsWith(`/${repoSpec}`)) {
          if (filePath.startsWith(pathToIgnore)) {
            this.debug(`ignoring file ${filePath} in ${repo} as it matches ignored path ${pathToIgnore} (colon format)`)
            return true
          }
        }
        continue
      }

      //Check for owner/repo/path pattern (legacy slash format)
      if (ignoredPath.includes("/")) {
        const parts = ignoredPath.split("/")

        //Owner/repo/path format (at least 3 parts)
        if (parts.length >= 3) {
          const ownerRepo = `${parts[0]}/${parts[1]}`
          const pathToIgnore = parts.slice(2).join("/")
          if (repo === ownerRepo && filePath.startsWith(pathToIgnore)) {
            this.debug(`ignoring file ${filePath} in ${repo} as it matches ignored path ${pathToIgnore}`)
            return true
          }
        }
        //Handle repo/path format (2 parts)
        else if (parts.length === 2) {
          const [, pathToIgnore] = parts
          if (repo.endsWith(`/${parts[0]}`) && filePath.startsWith(pathToIgnore)) {
            this.debug(`ignoring file ${filePath} in ${repo} as it matches ignored path ${pathToIgnore}`)
            return true
          }
        }
      }
      //Simple path ignoring for all repos
      else if (filePath.startsWith(ignoredPath)) {
        this.debug(`ignoring file ${filePath} as it matches ignored path ${ignoredPath}`)
        return true
      }
    }
    return false
  }

  /**Wrapper for linguist to handle path ignoring */
  async filteredLinguist(path, options) {
    const {repo} = options

    //First call the original linguist method to get results
    const results = await this.linguist(path, options)

    //Filter out results for ignored paths
    const filteredLines = {}
    const filteredStats = {}
    let filteredTotal = 0
    let filteredFiles = 0
    let ignoredFiles = 0

    //Process each language entry
    for (const [language,] of Object.entries(results.lines)) {
      filteredLines[language] = 0
    }

    for (const [language,] of Object.entries(results.stats)) {
      filteredStats[language] = 0
    }

    this.debug(results)

    //Process file paths and filter out ignored ones
    if (results.files_details) {
      for (const fileDetail of results.files_details) {
        const filePath = fileDetail.path

        if (this.shouldIgnorePath(repo, filePath)) {
          ignoredFiles++
          //Skip this file's stats
          continue
        }

        //Include this file's stats
        filteredFiles++
        filteredTotal += fileDetail.total || 0

        //Add language-specific counts and stats
        if (fileDetail.language) {
          filteredLines[fileDetail.language] = (filteredLines[fileDetail.language] || 0) + (fileDetail.lines || 0)
          filteredStats[fileDetail.language] = (filteredStats[fileDetail.language] || 0) + (fileDetail.bytes || 0)
        }
      }

      //Return filtered results
      if (ignoredFiles > 0) {
        this.debug(`Filtered out ${ignoredFiles} files due to path ignore rules`)
      }

      return {
        ...results,
        lines:filteredLines,
        stats:filteredStats,
        total:filteredTotal,
        files:filteredFiles,
        files_details:results.files_details.filter(f => !this.shouldIgnorePath(repo, f.path))
      }
    }

    //If linguist doesn't provide file details, we can't filter effectively
    this.debug("Warning: Unable to filter paths effectively as linguist didn't return file details")
    return results
  }

  /**Analyze a repository */
  async analyze(path, {commits = []} = {}) {
    const cache = {files:{}, languages:{}}
    const start = Date.now()
    let elapsed = 0, processed = 0
    const {repo} = this.parse(path)

    if (this.timeout.repositories)
      this.debug(`timeout for repository analysis set to ${this.timeout.repositories}m`)
    for (const commit of commits) {
      elapsed = (Date.now() - start) / 1000 / 60
      if ((this.timeout.repositories) && (elapsed > this.timeout.repositories)) {
        this.results.partial.repositories = true
        this.debug(`reached maximum execution time of ${this.timeout.repositories}m for repository analysis (${elapsed}m elapsed)`)
        break
      }
      try {
        const {total, files, missed, lines, stats} = await this.filteredLinguist(path, {commit, cache, repo})
        this.results.commits++
        this.results.total += total
        this.results.files += files
        this.results.missed.lines += missed.lines
        this.results.missed.bytes += missed.bytes
        for (const language in lines) {
          if (this.categories.includes(cache.languages[language]?.type))
            this.results.lines[language] = (this.results.lines[language] ?? 0) + lines[language]
        }
        for (const language in stats) {
          if (this.categories.includes(cache.languages[language]?.type))
            this.results.stats[language] = (this.results.stats[language] ?? 0) + stats[language]
        }
      }
      catch (error) {
        this.debug(`skipping commit ${commit.sha} (${error})`)
        this.results.missed.commits++
      }
      finally {
        this.results.elapsed += elapsed
        processed++
        if ((processed % 50 === 0) || (processed === commits.length))
          this.debug(`at commit ${processed}/${commits.length} (${(100 * processed / commits.length).toFixed(2)}%, ${elapsed.toFixed(2)}m elapsed)`)
      }
    }
    this.results.colors = Object.fromEntries(Object.entries(cache.languages).map(([lang, {color}]) => [lang, color]))
  }

  /**Clean a path */
  async clean(path) {
    try {
      this.debug(`cleaning ${path}`)
      await fs.rm(path, {recursive:true, force:true})
      this.debug(`cleaned ${path}`)
      return true
    }
    catch (error) {
      this.debug(`failed to clean (${error})`)
      return false
    }
  }

  /**Whether to skip a repository or not */
  ignore(repository) {
    const ignored = !filters.repo(repository, this.skipped)
    if (ignored)
      this.debug(`skipping ${typeof repository === "string" ? repository : `${repository?.owner?.login}/${repository?.name}`} as it matches skipped repositories`)
    return ignored
  }

  /**Debug log */
  debug(message) {
    return console.debug(`metrics/compute/${this.login}/plugins > languages > ${this.constructor.name.replace(/([a-z])([A-Z])/, (_, a, b) => `${a} ${b.toLocaleLowerCase()}`).toLocaleLowerCase()} > ${message}`)
  }
}
