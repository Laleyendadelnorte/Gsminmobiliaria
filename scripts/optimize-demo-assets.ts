import sharp from 'sharp';
import {access} from 'node:fs/promises';
async function main(){for(let n=1;n<=6;n++){const source=`public/images/house-${n}.jpg`;await access(source);for(const width of [480,960,1920])await sharp(source).resize({width,withoutEnlargement:true}).webp({quality:80}).toFile(`public/images/house-${n}-${width}.webp`);}}
main().catch(e=>{console.error(e);process.exit(1)});
