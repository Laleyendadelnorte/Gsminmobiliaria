import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {db,query} from '../src/server/db';
import type {AuthContext} from '../src/server/auth';
import {ApiError} from '../src/server/errors';
const enabled=process.env.MEDIA_INTEGRATION_TEST==='1'&&/gcm_test(?:\?|$)/.test(process.env.DATABASE_URL||'');
test('Private media: bounded decoding, physical quota and immediate invitation revocation',{skip:!enabled,timeout:120000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'gcm-media-test-'));process.env.MEDIA_ROOT=root;delete process.env.S3_ENDPOINT;process.env.SESSION_SECRET='isolated-media-test-'+randomUUID();
 const {uploadMedia,serveMedia,signMediaUrl}=await import('../src/server/media');
 const d=await import('../src/server/domain');
 const [org]=await query('INSERT INTO organizations(name) VALUES($1) RETURNING id',['MEDIA TEST '+randomUUID()]);
 const [user]=await query('INSERT INTO users(email,name) VALUES($1,$2) RETURNING id',[randomUUID()+'@example.invalid','Media Test']);
 const ctx:AuthContext={organizationId:org.id,userId:user.id,role:'ADMIN'};
 await query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'ADMIN')",[org.id,user.id]);
 try{
 const p=await d.createProperty(ctx,{code:'MEDIA-'+randomUUID(),title:'Media test',type:'CASA',status:'PUBLICADA',priceMinor:100000,currency:'DOP'});
 await t.test('Stream without Content-Length rejected at aggregate limit and cancelled',async()=>{
 let cancelled=false;const stream=new ReadableStream({pull(c){c.enqueue(new Uint8Array(1024*1024))},cancel(){cancelled=true}});
 const request=new Request('https://gcm.test/api/properties/'+p.id+'/media',{method:'POST',body:stream,duplex:'half',headers:{'content-type':'multipart/form-data; boundary=example'}} as RequestInit);
 await assert.rejects(()=>uploadMedia(request,ctx,p.id),(e)=>e instanceof ApiError&&e.status===413);assert.equal(cancelled,true);
 });
 let media:any;
 await t.test('Real decoded upload generates variants without enlargement and reserves actual bytes',async()=>{
 const bytes=await sharp({create:{width:1000,height:700,channels:3,background:'#c8ab78'}}).jpeg().toBuffer();
 const form=new FormData();form.set('file',new File([new Uint8Array(bytes)],'home.jpg',{type:'image/jpeg'}));
 const response=await uploadMedia(new Request('https://gcm.test/api/properties/'+p.id+'/media',{method:'POST',body:form}),ctx,p.id);
 assert.equal(response.status,201);media=await response.json();assert.equal(media.width,1000);
 const [blob]=await query('SELECT bytes,status FROM media_blobs WHERE id=$1',[media.id]);assert.equal(blob.status,'READY');assert.ok(Number(blob.bytes)>bytes.length);
 });
 const prospect=await d.createProspect(ctx,{name:'Media Client'});const offer=await d.createOfferDraft(ctx,{prospectId:prospect.id,propertyIds:[p.id]});await d.offerAction(ctx,offer.id,'publish',{approved:true});const published=await d.getOffer(ctx,{offerId:offer.id});
 const signed=signMediaUrl(media.url,offer.id,published.version);
 await t.test('Signed public derivative works; original still requires administrative authentication',async()=>{
 const response=await serveMedia(new Request('https://gcm.test'+signed),media.id);assert.equal(response.status,200);const meta=await sharp(Buffer.from(await response.arrayBuffer())).metadata();assert.equal(meta.format,'webp');assert.equal(meta.width,960);
 await assert.rejects(()=>serveMedia(new Request('https://gcm.test'+signed+'&original=true'),media.id),(e)=>e instanceof ApiError&&e.status===401);
 });
 await t.test('Already issued image URL fails immediately when invitation is revoked',async()=>{
 await d.offerAction(ctx,offer.id,'revoke',{});await assert.rejects(()=>serveMedia(new Request('https://gcm.test'+signed),media.id),(e)=>e instanceof ApiError&&e.status===401);
 });
 await t.test('Removing gallery entry cannot erase physical storage quota',async()=>{
 await d.updateProperty(ctx,p.id,{media:[]});assert.equal((await query('SELECT id FROM property_media WHERE id=$1',[media.id])).length,0);assert.equal((await query('SELECT id FROM media_blobs WHERE id=$1',[media.id])).length,1);
 });
 }finally{
 for(const table of ['portal_sessions','access_invites','request_keys','audit_logs','offer_versions','offer_properties','offers','prospect_preferences','prospects','property_media','media_blobs','property_status_history','properties','terms_versions','settings','memberships'])await query(`DELETE FROM ${table} WHERE organization_id=$1`,[org.id]);
 await query('DELETE FROM organizations WHERE id=$1',[org.id]);await query('DELETE FROM users WHERE id=$1',[user.id]);await rm(root,{recursive:true,force:true});await db.end();
 }
});
