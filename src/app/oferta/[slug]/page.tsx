import Portal from '@/components/portal';
export default async function Page({params}:{params:Promise<{slug:string}>}){const {slug}=await params;return <Portal slug={slug}/>}
