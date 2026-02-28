import { type ExtendedRecordMap } from 'notion-types'
import { getBlockTitle, getPageTitle, parsePageId } from 'notion-utils'

import type { PageProps } from './types'
import * as acl from './acl'
import { environment, pageUrlAdditions, pageUrlOverrides, site } from './config'
import { db } from './db'
import { getCanonicalPageId } from './get-canonical-page-id'
import { getSiteMap } from './get-site-map'
import { getPage } from './notion'

// Helper to check if a block links to a draft page
function isDraftPageBlock(
  blockId: string,
  recordMap: ExtendedRecordMap
): boolean {
  const block = recordMap.block[blockId]?.value
  if (!block) return false

  // Check if it's a page block or a link to a page
  if (block.type === 'page' || block.type === 'alias') {
    const title = getBlockTitle(block, recordMap)
    return title ? title.toLowerCase().includes('[draft]') : false
  }

  return false
}

// Filter out draft page blocks from the recordMap
function filterDraftPages(recordMap: ExtendedRecordMap): ExtendedRecordMap {
  const filteredBlocks: typeof recordMap.block = {}
  const draftBlockIds = new Set<string>()

  // First pass: identify draft page blocks
  for (const [blockId, _] of Object.entries(recordMap.block)) {
    if (isDraftPageBlock(blockId, recordMap)) {
      draftBlockIds.add(blockId)
    }
  }

  // Second pass: copy non-draft blocks and filter content arrays
  for (const [blockId, blockData] of Object.entries(recordMap.block)) {
    if (draftBlockIds.has(blockId)) {
      continue // Skip draft blocks entirely
    }

    // Clone the block and filter out draft references from content
    const block = blockData?.value
    if (block?.content) {
      const filteredContent = block.content.filter(
        (childId: string) => !draftBlockIds.has(childId)
      )
      filteredBlocks[blockId] = {
        ...blockData,
        value: {
          ...block,
          content: filteredContent
        }
      }
    } else {
      filteredBlocks[blockId] = blockData
    }
  }

  return {
    ...recordMap,
    block: filteredBlocks
  }
}

export async function resolveNotionPage(
  domain: string,
  rawPageId?: string
): Promise<PageProps> {
  let pageId: string | undefined
  let recordMap: ExtendedRecordMap

  if (rawPageId && rawPageId !== 'index') {
    pageId = parsePageId(rawPageId)!

    if (!pageId) {
      // check if the site configuration provides an override or a fallback for
      // the page's URI
      const override =
        pageUrlOverrides[rawPageId] || pageUrlAdditions[rawPageId]

      if (override) {
        pageId = parsePageId(override)!
      }
    }

    const useUriToPageIdCache = true
    const cacheKey = `uri-to-page-id:${domain}:${environment}:${rawPageId}`
    // Use a TTL so stale slug→pageId mappings expire when page titles change
    const cacheTTL = 8.64e7 // one day in milliseconds

    if (!pageId && useUriToPageIdCache) {
      try {
        // check if the database has a cached mapping of this URI to page ID
        pageId = await db.get(cacheKey)

        // console.log(`redis get "${cacheKey}"`, pageId)
      } catch (err: any) {
        // ignore redis errors
        console.warn(`redis error get "${cacheKey}"`, err.message)
      }
    }

    if (pageId) {
      recordMap = await getPage(pageId)
    } else {
      // handle mapping of user-friendly canonical page paths to Notion page IDs
      // e.g., /developer-x-entrepreneur versus /71201624b204481f862630ea25ce62fe
      const siteMap = await getSiteMap()
      pageId = siteMap?.canonicalPageMap[rawPageId]

      if (!pageId) {
        // Fallback: the slug wasn't found directly in canonicalPageMap.
        // This can happen when the page title changed (so the slug changed)
        // or the page is deeper than the sitemap traversal depth.
        // Try a reverse lookup: iterate all pages and regenerate their
        // canonical slug to find a match.
        for (const [candidatePageId, candidateRecordMap] of Object.entries(
          siteMap.pageMap
        )) {
          if (!candidateRecordMap) continue
          const candidateSlug = getCanonicalPageId(
            candidatePageId,
            candidateRecordMap,
            { uuid: false }
          )
          if (candidateSlug === rawPageId) {
            pageId = candidatePageId
            break
          }
        }
      }

      if (pageId) {
        // TODO: we're not re-using the page recordMap from siteMaps because it is
        // cached aggressively
        // recordMap = siteMap.pageMap[pageId]

        recordMap = await getPage(pageId)

        if (useUriToPageIdCache) {
          try {
            // update the database mapping of URI to pageId
            await db.set(cacheKey, pageId, cacheTTL)

            // console.log(`redis set "${cacheKey}"`, pageId, { cacheTTL })
          } catch (err: any) {
            // ignore redis errors
            console.warn(`redis error set "${cacheKey}"`, err.message)
          }
        }
      } else {
        // note: we're purposefully not caching URI to pageId mappings for 404s
        return {
          error: {
            message: `Not found "${rawPageId}"`,
            statusCode: 404
          }
        }
      }
    }
  } else {
    pageId = site.rootNotionPageId

    console.log(site)
    recordMap = await getPage(pageId)
  }

  // Block access to pages with "[draft]" in the title (case-insensitive)
  const title = getPageTitle(recordMap)
  if (title && title.toLowerCase().includes('[draft]')) {
    return {
      error: {
        message: `Not found "${rawPageId}"`,
        statusCode: 404
      }
    }
  }

  // Filter out draft page blocks from the content
  const filteredRecordMap = filterDraftPages(recordMap)

  const props: PageProps = { site, recordMap: filteredRecordMap, pageId }
  return { ...props, ...(await acl.pageAcl(props)) }
}
