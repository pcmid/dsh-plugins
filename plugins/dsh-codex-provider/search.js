/** Only trust URLs Codex reports as search results or structured citations, never parse links from prose. */
export class SearchResults {
  searched = false
  sources = new Map()
  refs = new Map()
  answer = ''

  add(row) {
    if (typeof row?.url !== 'string' || !/^https?:\/\//i.test(row.url)) return
    const url = URL.parse(row.url)?.href
    if (!url) return
    if (!this.sources.has(url)) {
      this.sources.set(url, { url, ...(typeof row.title === 'string' && { title: row.title }),
        ...(typeof row.snippet === 'string' && { snippet: row.snippet }) })
    }
    if (typeof row.ref_id === 'string') this.refs.set(row.ref_id, url)
  }

  item(item) {
    if (item.type === 'webSearch') {
      this.searched = true
      this.answer = ''
      if (Array.isArray(item.results)) for (const row of item.results) this.add(row)
    } else if (item.type === 'agentMessage' && item.phase !== 'commentary' && typeof item.text === 'string') {
      this.answer = item.text
    }
  }

  raw(item) {
    if (item.type === 'web_search_call' && item.status === 'failed') throw new Error('Codex web search failed')
    if (!this.searched || item.type !== 'message' || item.role !== 'assistant') return
    for (const part of item.content ?? []) {
      for (const citation of part.annotations ?? []) if (citation.type === 'url_citation') this.add(citation)
    }
  }

  result() {
    if (!this.searched) throw new Error('Codex finished without executing web search')
    if (!this.sources.size) throw new Error('Codex web search returned no HTTP(S) sources')
    // Standalone search sometimes emits private cite markers instead of Markdown links.
    const content = this.answer.replace(/\uE200cite([^\uE200\uE201]*)\uE201/gu, (_, ids) =>
      ids.split('\uE202').filter(id => this.refs.has(id)).map(id => `[${id}](<${this.refs.get(id)}>)`).join(' ')).trim()
    return { ...(content && { content }), sources: [...this.sources.values()] }
  }
}
