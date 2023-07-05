import N3 from "n3";
import {Readable, Transform} from "stream";
import {JSONSchema7} from "json-schema";
import {jsonSchemaToGraphQLQuery} from "@slub/json-schema-to-graphql";
import axios from "axios";
import * as fs from "fs";
import rdf from '@rdfjs/data-model'
import {BaseQuad, DataFactory, Quad, Term} from "@rdfjs/types";
import {JsonLdParser} from "jsonld-streaming-parser";
import toReadable from 'duplex-to/readable.js'
// @ts-ignore
import Sink from '@rdfjs/sink'


const API_URL = "http://localhost:8000";
const GRAPHQL_URL = "http://localhost:8000/graphql";
const TYPE_NAME = "Person";

const BASE_IRI = "http://ontologies.slub-dresden.de/exhibition/";
const VOCAB_IRI = BASE_IRI;
const ENTITY_BASE = "http://ontologies.slub-dresden.de/exhibition/entity";
const LIMIT_PER_PAGE = -1;
const relativeIriProtocol = 'null:'
function termCleanup (factory: DataFactory) {
  return (term: Term) => {
    if (term.termType !== 'NamedNode') {
      return null
    }

    if (!term.value.startsWith(relativeIriProtocol)) {
      return null
    }

    // remove dummy protocol workaround for relative IRIs
    return factory.namedNode(term.value.slice(relativeIriProtocol.length))
  }
}
function quadCleanup (factory: DataFactory) {
  const cleanup = termCleanup(factory)

  return (quad: Quad) => {
    const subject = cleanup(quad.subject)
    const predicate = cleanup(quad.predicate)
    const object = cleanup(quad.object)
    const graph = cleanup(quad.graph)

    if (subject || predicate || object || graph) {
      return factory.quad(
          subject || quad.subject,
          predicate || quad.predicate,
          object || quad.object,
          graph || quad.graph
      )
    }

    return quad
  }
}

class ParserStream {
  // @ts-ignore
  constructor (input: any, { baseIRI = relativeIriProtocol, context = null, documentLoader, factory = rdf } = {}) {
    const parser = new JsonLdParser({
      baseIRI,
      context: context || undefined,
      dataFactory: factory,
      documentLoader,
      streamingProfile: true
    })

    input.pipe(parser)

    const cleanup = quadCleanup(factory)

    const transform = new Transform({
      objectMode: true,
      transform: (quad, encoding, callback) => {
        callback(null, cleanup(quad))
      }
    })

    parser.on('context', context => {
      Object.entries(context).forEach(([prefix, iri]) => {
        if(typeof iri === 'string') return;
        transform.emit('prefix', prefix, factory.namedNode(iri as string))
      })
    })
    parser.on('error', err => transform.destroy(err))
    parser.pipe(transform)

    return toReadable(transform)
  }
}

export const defs: (schema: JSONSchema7) => NonNullable<JSONSchema7['definitions']> = (schema: JSONSchema7) => schema.$defs || schema.definitions || {}
export const bringDefinitionsToTop = (schema: JSONSchema7, key: string) => {
  const definitionsKey = '$defs' in schema ? '$defs' : 'definitions'
  return ({
    ...schema,
    ...((schema[definitionsKey] as any)[key] || {})
  })
}

export const allDefinitions = (schema: JSONSchema7) => Object.keys(defs(schema))
const fetchEntities: (url: string, typeName: string, schema: JSONSchema7) => Promise<any> = async (url, typeName: string, schema: JSONSchema7) => {
  const query = jsonSchemaToGraphQLQuery(typeName, schema,
      {
      input: (LIMIT_PER_PAGE > 0 ?
          {
            pagination: {
              limit: LIMIT_PER_PAGE
            }
          } : null),
        propertyBlacklist: [ 'externalId' ],
        additionalFields: [
          'id',
          '__typename'
        ],
        list: true
      });
  const queryName = `get${typeName}List`;
  const data = await axios.post(url, {
    operationName: queryName, query
  }, {
    headers: {
      'Content-Type': 'application/json'
    }
  }).catch((e) => {
    console.error(e);
  });
  const result = data?.data?.data?.[queryName];
  if (!result) {
    console.error(`No result for ${queryName} found!`)
    console.log(data?.data?.errors)
  }
  return result;
}

const fetchSchema: (url: string) => Promise<JSONSchema7> = async (url: string) => {
  const data = await axios.get(url);
  return data.data as JSONSchema7;
}


const getEntityIRI = (id: string, typeName: string) => `${ENTITY_BASE}/${typeName}#${id?.length > 0 ? `s-${id}` : ''}`;
const getClassIRI = (typeName: string) => `${BASE_IRI}${typeName}`;

const graphQLTypeName = (graphqlTypeName: string) => graphqlTypeName.replace(/Type$/, '');  // remove List suffix

const extendObjectWithJSONLD = ({id, __typename, ...entity}: any) => {
  if (!id || !__typename) {
    return entity;
  }
  const typeName = graphQLTypeName(__typename);
  return ({
    "@type": getClassIRI(typeName),
    "@id": getEntityIRI(id, typeName),
    id,
    ...entity
  });
}
const recursivelySemantify = (entity: any) => {
  if (!entity || typeof entity !== 'object') {
    return entity;
  }
  const newEntry = Object.fromEntries(
      Object.entries(entity).map(([key, value]) => {
        let val = value;
        if (typeof value === 'object') {
          val = recursivelySemantify(value);
        }
        if (Array.isArray(value)) {
          val = value.map((v) => recursivelySemantify(v));
        }
        return [key, val];
      }))
  return extendObjectWithJSONLD(newEntry);
}
const makeJSONLD = (entity: any) => {
  return ({
    "@context": {
      "@vocab": VOCAB_IRI,
    },
    ...recursivelySemantify(entity)
  });
}

const allTypeNames = (schema: JSONSchema7) => Object.keys(defs(schema)).map(graphQLTypeName);
const mapEntitiesToRDF = async (typeName: string, rootSchema: JSONSchema7) => {
  const schema = bringDefinitionsToTop(rootSchema, typeName);
  const entities = await fetchEntities(GRAPHQL_URL, typeName, schema) as any[];
  if(!entities) {
    console.log(`no entities found for ${typeName}`);
    return;
  }

  const typePrefixes = Object.fromEntries(allTypeNames(rootSchema).map((typeName: string) => [typeName.toLowerCase(), getEntityIRI('', typeName)]))
  const jsonldEntities = entities.map((entity: any, index) => JSON.stringify(makeJSONLD(entity)))
    // @ts-ignore
  const parserJsonld = new Sink(ParserStream, { baseIRI: VOCAB_IRI })
  const fileStream = fs.createWriteStream(`./out/${typeName}.ttl`, {flags: 'w', encoding: 'utf8'})
  const writer = new N3.Writer(fileStream, {format: 'Turtle', prefixes: {'': VOCAB_IRI, ...typePrefixes}}  )
  const input = new Readable({
    read: () => {
      const element: any = jsonldEntities.pop()
      input.push(element ? element : null)
      //input.push(null)
    }
  })

  // @ts-ignore
  const output = parserJsonld.import(input)
  output.on('data', function (quad: any) {
    try {
      writer.addQuad(quad)
    } catch (e) {

    }
  })
  output.on('end', function () {
    writer.end()
    fileStream.close()
  })

  output.on('error', function (error: any) {
    console.log('Something went wrong:')
    console.log(error)
  })


}

const run = async ( ) => {
  const rootSchema = await fetchSchema(`${API_URL}/schema`);
  const allTypes = allTypeNames(rootSchema);
  for (const typeName of allTypes) {
    console.log(`start downloading ${typeName}...`);
    await mapEntitiesToRDF(typeName, rootSchema);
    console.log(`finished downloading ${typeName}...`);
  }
}

run()