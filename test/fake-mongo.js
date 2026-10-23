'use strict'
const { ObjectId } = require('mongodb')
const copy = value => {
  if (value instanceof Date) return new Date(value)
  if (value instanceof ObjectId) return new ObjectId(String(value))
  if (Array.isArray(value)) return value.map(copy)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,copy(v)]))
  return value
}
const get = (value, key) => key.split('.').reduce((v,k)=>v && v[k],value)
function match(value, query) {
  return Object.entries(query).every(([key, want]) => {
    const actual = get(value,key)
    if (want && typeof want === 'object' && !(want instanceof ObjectId) && !(want instanceof Date)) {
      return Object.entries(want).every(([op,v])=>op==='$exists' ? ((actual!==undefined)===v) :
        op==='$lt' ? actual<v : op==='$lte' ? actual<=v : op==='$gte' ? actual>=v : op==='$gt' ? actual>v : false)
    }
    return String(actual)===String(want)
  })
}
function set(value,key,v,remove=false) {
  const parts=key.split('.');const last=parts.pop();let parent=value
  for(const p of parts) parent=parent[p]||(parent[p]={})
  if(remove)delete parent[last];else parent[last]=copy(v)
}
function patch(value,update){for(const [op,fields]of Object.entries(update))for(const [key,v]of Object.entries(fields)){
  if(op==='$set')set(value,key,v);if(op==='$unset')set(value,key,null,true);if(op==='$inc')set(value,key,(get(value,key)||0)+v)
}}
class Cursor{
  constructor(rows){this.rows=rows.map(copy);this.limitN=Infinity;this.skipN=0;this.offset=0}
  sort(order){const [key,dir]=Object.entries(order)[0];this.rows.sort((a,b)=>a[key]<b[key]?-dir:a[key]>b[key]?dir:0);return this}
  limit(n){this.limitN=n;return this}skip(n){this.skipN=n;return this}batchSize(){return this}maxTimeMS(){return this}
  async toArray(){return this.rows.slice(this.skipN,this.skipN+this.limitN).map(copy)}
  async next(){return copy((await this.toArray())[this.offset++]||null)}
  async hasNext(){return this.offset<(await this.toArray()).length}
}
function create(initial={}){
 const rows=new Map(Object.entries(initial).map(([k,v])=>[k,v.map(copy)])),options=new Map();let fail=null
 const api={rows,options,calls:[],capOverride:null,failAt:(name,after=false)=>{fail={name,after}},
  trip(name,after){if(fail&&fail.name===name&&fail.after===after){fail=null;throw new Error('Simulated crash '+name)}},
  listCollections(query){return{toArray:async()=>options.has(query.name)?[{name:query.name,options:copy(options.get(query.name))}]:[]}},
  async createCollection(name,opt){if(rows.has(name))throw new Error('Namespace exists');rows.set(name,[]);options.set(name,copy(opt));return api.collection(name)},
  collection(name){if(!rows.has(name))rows.set(name,[]);const data=rows.get(name);return{
   find(query={}){return new Cursor(data.filter(r=>match(r,query)))},async findOne(query){return copy(data.find(r=>match(r,query))||null)},
   async insertOne(row){api.trip(name+'.insert',false);if(data.some(r=>String(r._id)===String(row._id))){const e=new Error('Duplicate');e.code=11000;throw e}data.push(copy(row));if(options.has(name)&&options.get(name).capped){const cap=api.capOverride||options.get(name).max;while(data.length>cap)data.shift()}api.trip(name+'.insert',true);return{insertedId:row._id}},
   async insertMany(list){for(const row of list)await this.insertOne(row)},
   async updateOne(query,update,opts={}){api.calls.push({collection:name,method:'updateOne',query:copy(query),update:copy(update),options:copy(opts)});api.trip(name+'.update',false);let row=data.find(r=>match(r,query));if(row)patch(row,update);else if(opts.upsert){row=copy(update.$setOnInsert);data.push(row);if(options.has(name)&&options.get(name).capped){const cap=api.capOverride||options.get(name).max;while(data.length>cap)data.shift()}}api.trip(name+'.update',true);return{matchedCount:row?1:0}},
   async findOneAndUpdate(query,update,opts={}){api.calls.push({collection:name,method:'findOneAndUpdate',query:copy(query),update:copy(update),options:copy(opts)});api.trip(name+'.commit',false);const row=data.find(r=>match(r,query));const before=copy(row||null);if(row)patch(row,update);api.trip(name+'.commit',true);let value=opts.returnDocument==='after'?copy(row||null):before;if(value&&opts.projection)value=Object.fromEntries(Object.entries(value).filter(([key])=>opts.projection[key]===1));return opts.includeResultMetadata?{value}:value},
   async estimatedDocumentCount(){return data.length},
   aggregate(pipeline){const query=(pipeline.find(p=>p.$match)||{}).$match||{};const groups={};for(const row of data.filter(r=>match(r,query)))groups[row.status]=(groups[row.status]||0)+1;return{toArray:async()=>Object.entries(groups).map(([status,count])=>({_id:status,count}))}}
  }}
 }
 return api
}
module.exports={create,copy,ObjectId}
