import { SearchIndex } from 'algoliasearch'
import { standardValues } from './util'
import { SanityDocumentStub, SanityClient } from '@sanity/client'
import { AlgoliaRecord, SerializeFunction, VisiblityFunction, WebhookBody } from './types'

export { flattenBlocks } from './util'

type IndexMap = {
  [key: string]: SearchIndex
}

const indexer = (
  typeIndexMap: IndexMap,
  // Defines how the transformation from Sanity document to Algolia record is performed
  serializer: SerializeFunction,
  // Optionally provide logic for which documents should be visible or not.
  // Useful if your documents have a isHidden or isIndexed property or similar
  visible?: VisiblityFunction) => {

  const transform = (documents: SanityDocumentStub[]) => {
    const records: AlgoliaRecord[] = documents.map((document: SanityDocumentStub) => {
      return Object.assign(standardValues(document), serializer(document))
    })
    return records
  }

  // Based on an Algolia index, a Sanity client and a Sanity webhook post body,
  // sync the Sanity documents to Algolia records based on the types, serialize
  // and visibilty rules
  const webhookSync = async (client: SanityClient, body: WebhookBody) => {
    // Query Sanity for more information
    //
    // Fetch the full objects that we are probably going to index in Algolia. Some
    // of these might get filtered out later depending on fields the documents
    // might have set.
    const query = `* [(_id in $created + $updated) && _type in $types]`
    const { created, updated } = body.ids
    const docs: SanityDocumentStub[] = await client.fetch(query, {
      created,
      updated,
      types: Object.keys(typeIndexMap)
    })

    // In the event that a field on a document was updated such that it is no
    // longer visible (visible set to false, published set to false etc) we need
    // to make sure these are removed if they have been indexed previously. We do
    // this by calculating the diff between ids we're about to save and all ids
    // that came in as created or updated. The resulting difference is added into
    // the delete operation further down.
    const allCreatedOrUpdated = created.concat(updated)
    const visibleRecords = docs.filter(document => {
      return visible ? visible(document) : true
    })
    const visibleIds = visibleRecords.map((doc: any) => doc._id)
    const hiddenIds = allCreatedOrUpdated.filter((id: string) => !visibleIds.includes(id))

    const recordsToSave = transform(visibleRecords)

    if (recordsToSave.length > 0) {
      for (const type in typeIndexMap) {
        await typeIndexMap[type].saveObjects(
          recordsToSave.filter(r => r.type === type)
        )
      }
    }

    /*
     * Optimalization: We can check the history of the deleted document(s) with
     * history API to see if they were of a type that we have probably indexed
     * before. Right now we blankly tell Algolia to try to delete any deleted record
     * in any index we have.
     */
    const { deleted } = body.ids
    const recordsToDelete = deleted.concat(hiddenIds)

    if (recordsToDelete.length > 0) {
      for await (const typeIndex of Object.values(typeIndexMap)) {
        typeIndex.deleteObjects(recordsToDelete)
      }
    }
  }

  return { transform, webhookSync }
}

export default indexer