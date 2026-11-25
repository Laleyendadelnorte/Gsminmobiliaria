import './env';
import {db,transaction} from '../src/server/db';
let stopping=false;
process.on('SIGTERM',()=>{stopping=true});process.on('SIGINT',()=>{stopping=true});
async function tick(){await transaction(async c=>{
 await c.query(`WITH expired AS (UPDATE visits SET status='CANCELADA',cancelled_at=now(),updated_at=now() WHERE status='PENDIENTE_PAGO' AND hold_expires_at<now() RETURNING id) UPDATE payments SET status='EXPIRADO',updated_at=now() WHERE visit_id IN (SELECT id FROM expired) AND status='PENDIENTE'`);
 await c.query('DELETE FROM sessions WHERE expires_at<now()');await c.query('DELETE FROM portal_sessions WHERE expires_at<now()');await c.query('DELETE FROM rate_limits WHERE expires_at<now()');
 });}
async function main(){while(!stopping){try{await tick()}catch(e){console.error(JSON.stringify({event:'maintenance_failed',type:e instanceof Error?e.name:'unknown'}))}await new Promise(r=>setTimeout(r,30000));}await db.end();}
main().catch(()=>{process.exitCode=1});
