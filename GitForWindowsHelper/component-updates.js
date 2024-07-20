const guessComponentUpdateDetails = (title, body) => {
    let [ , package_name, version ] =
        title.match(/^\[New (\S+) version\] (?:[^0-9]+\s+)?(\S+(?:\s+patch\s+\d+)?)(?! new items)/) ||
        title.match(/^(\S+): update to v?(\d[0-9.]\S*)/) ||
        title.match(/^(msys2-runtime): update to ([0-9a-f]{40,64})/) ||
        body.match(/^# \[New (\S+) version\] (?:[^0-9]+\s+)?(\S+(?:\s+patch\s+\d+)?)/) ||
        []
    if (!package_name || !version) throw new Error(`Could not guess component-update details from title '${title}'`)

    if (['git-lfs'].includes(package_name)) package_name = `mingw-w64-${package_name}`
    else if (['git-credential-manager', 'gcm-core', 'gcm'].includes(package_name)) package_name = 'mingw-w64-git-credential-manager'
    else if (package_name === 'cygwin') package_name = 'msys2-runtime'
    else if (package_name === 'gpg') package_name = 'gnupg'
    else if (['clang', 'llvm', 'mingw-w64-clang'].includes(package_name)) package_name = 'mingw-w64-llvm'

    version = version
        .replace(/^(GCM |openssl-|OpenSSL_|v|V_|GnuTLS |tig-|Heimdal |cygwin-|PCRE2-|Bash-|curl-|gnupg-|is-)/, '')
        .replace(/\s+patch\s+/, '.')
        .replace(/_/g, '.')
        .replace(/-release$/, '')

    return { package_name, version }
}

const prettyPackageName = (name) => {
    return {
        'git-credential-manager': 'Git Credential Manager',
        'git-lfs': 'Git LFS',
        'msys2-runtime': 'MSYS2 runtime',
        bash: 'Bash',
        curl: 'cURL',
        gnupg: 'GNU Privacy Guard',
        gnutls: 'GNU TLS',
        heimdal: 'Heimdal',
        mintty: 'MinTTY',
        openssh: 'OpenSSH',
        openssl: 'OpenSSL',
        pcre2: 'PCRE2',
        perl: 'Perl',
        tig: 'Tig',
        innosetup: 'InnoSetup',
    }[name] || name
}

const isMSYSPackage = package_name => {
    return package_name !== 'git-extra'
        && !package_name.startsWith('mingw-w64-')
}

const packageNeedsBothMSYSAndMINGW = package_name => {
    return ['openssl', 'curl', 'gnutls', 'pcre2'].includes(package_name)
}

const needsSeparateARM64Build = package_name => {
    if (package_name === 'git-extra') return true
    return package_name.startsWith('mingw-w64-') && ![
        'mingw-w64-git-credential-manager',
        'mingw-w64-git-lfs',
        'mingw-w64-wintoast'
    ].includes(package_name)
}

const guessCygwinReleaseNotesURL = async (version) => {
    const { fetchHTML } = require('./https-request')
    const html = await fetchHTML('https://cygwin.com')
    const match = html.match(new RegExp(`The most recent version of the Cygwin DLL is[^]*?<a href=['"]?([^"' ]*)[^>]*>${version}</a>`))
    if (match) return match[1]

    // Sometimes Cygwin updates the home page a bit later than we'd want, let's
    // find the announcement on the mailing list directly in that case:
    const inboxPrefix = 'https://inbox.sourceware.org/cygwin-announce/'
    const search = await fetchHTML(`${inboxPrefix}?q=cygwin-${version}`)
    const searchMatch = search.match(new RegExp(`<a\\b(?:[^>]*)\\shref=['"]?([^'" ]+)[^>]*>cygwin ${version}-1</a>`))
    if (searchMatch) return `${inboxPrefix}${searchMatch[1]}`

    throw new Error(`Could not determine Cygwin Release Notes URL for version ${version}`)
}

const guessReleaseNotes = async (context, issue) => {
    if (!issue.pull_request
        &&issue.labels.filter(label => label.name === 'component-update').length !== 1) throw new Error(`Cannot determine release note from issue ${issue.number}`)
    let { package_name, version } = guessComponentUpdateDetails(issue.title, issue.body)

    if (package_name === 'msys2-runtime') {
        const url = await guessCygwinReleaseNotesURL(version)
        const message = `Comes with the MSYS2 runtime (Git for Windows flavor) based on [Cygwin v${version}](${url}).`
        return {
            type: 'feature',
            message,
            package: package_name,
            version
        }
    }

    const matchURLInIssue = (issue) => {
        const pattern = {
            bash: /(?:^|\n)(https:\/\/\S+)/, // use the first URL
            gnutls: /(https:\/\/[^\s)]+)/
        }[package_name.toLowerCase().replace(/^mingw-w64-/, '')] || /(?:^|\n)(https:\/\/\S+)$/
        const match = issue.body.match(pattern)
        return match && match[1]
    }

    const matchURL = async () => {
        switch (package_name.replace(/^mingw-w64-/, '')) {
        case 'perl': return `http://search.cpan.org/dist/perl-${version}/pod/perldelta.pod`
        case 'curl': return `https://curl.se/changes.html#${version.replaceAll('.', '_')}`
        case 'openssl': return `https://www.openssl.org/news/openssl-${
            version.replace(/^(1\.1\.1|[3-9]\.\d+).*/, '$1')
        }-notes.html`
        }

        if (!issue.pull_request) return matchURLInIssue(issue)

        const match = issue.body.match(/See (https:\/\/\S+) for details/)
        if (match) return match[1]

        const issueMatch = issue.body.match(/https:\/\/github\.com\/git-for-windows\/git\/issues\/(\d+)/)
        if (issueMatch) {
            const githubApiRequest = require('./github-api-request')
            const issue = await githubApiRequest(
                context,
                null,
                'GET',
                `/repos/git-for-windows/git/issues/${issueMatch[1]}`
            )
            return matchURLInIssue(issue)
        }
    }

    const url = await matchURL()
    if (!url) throw new Error(`Could not determine URL from issue ${issue.number}`)

    const prettyName = prettyPackageName(package_name.replace(/^mingw-w64-/, ''))

    return {
        type: 'feature',
        message: `Comes with [${prettyName} v${version}](${url}).`,
        package: package_name,
        version
    }
}

const pacmanRepositoryBaseURL = 'https://wingit.blob.core.windows.net/'

const pacmanRepositoryURLs = (package_name, version, architectures) =>
    architectures.map(arch => {
        const fileName = isMSYSPackage(package_name)
            ? `${package_name}-${version}-1-${arch}.pkg.tar.xz`
            : `${package_name.replace(/^mingw-w64/, `$&-${arch}`)}-${version}-1-any.pkg.tar.xz`
        return `${pacmanRepositoryBaseURL}${arch.replace(/_/g, '-')}/${fileName}`
    })

const getMissingDeployments = async (package_name, version) => {
    // MinTTY is at epoch 1, which is part of Pacman's versioning scheme
    if (package_name === 'mintty') version = `1~${version}`
    // The `openssh` version looks like this: 9.1p1. But the website calls it 9.1_P1
    if (package_name === 'openssh') version = version.replace(/[_.]P/, 'p')
    // The `bash` version has its patch-level zero-padded to three digits
    if (package_name === 'bash') version = version.replace(/\d+$/, n => n.padStart(3, '0'))

    const architectures = ['i686', 'x86_64']
    if (package_name === 'msys2-runtime') architectures.shift()
    else if (package_name === 'msys2-runtime-3.3') architectures.pop()

    const urls = []
    const msysName = package_name.replace(/^mingw-w64-/, '')
    if (packageNeedsBothMSYSAndMINGW(msysName)) {
        urls.push(...pacmanRepositoryURLs(msysName, version, architectures))
        urls.push(...pacmanRepositoryURLs(`mingw-w64-${msysName}`, version, architectures))
    } else {
        urls.push(...pacmanRepositoryURLs(package_name, version, architectures))
    }
    const { doesURLReturn404 } = require('./https-request')
    const result = await Promise.all(urls.map(async url => doesURLReturn404(url)))
    return urls.filter((_, index) => result[index])
}

module.exports = {
    guessComponentUpdateDetails,
    guessReleaseNotes,
    prettyPackageName,
    isMSYSPackage,
    packageNeedsBothMSYSAndMINGW,
    needsSeparateARM64Build,
    getMissingDeployments
}