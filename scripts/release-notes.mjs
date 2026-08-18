const CONVENTIONAL = /^(\w+)(?:\(([^)]+)\))?:\s*(.*)/s

export default {
  generateNotes: async (_pluginConfig, context) => {
    const { commits, nextRelease } = context

    if (!commits || commits.length === 0) {
      return `## ${nextRelease.version}\n\n`
    }

    let notes = `## ${nextRelease.version}\n\n`

    for (const commit of commits) {
      const subject = commit.subject || commit.message?.split('\n')[0] || ''
      const match = subject.match(CONVENTIONAL)
      const type = match?.[1] || 'chore'
      const cleanSubject = match?.[3] || subject
      const hash = commit.hash?.slice(0, 7)
      const body = commit.body?.trim() ? `\n  ${commit.body.trim()}` : ''
      notes += `- **${type}:** ${cleanSubject} (\`${hash}\`)${body}\n\n`
    }

    return notes.trimEnd() + '\n'
  },
}
