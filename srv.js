const http=require('http'),fs=require('fs'),path=require('path');
const PORT=8080,DIR=__dirname;
http.createServer((req,res)=>{
  const f=path.join(DIR,req.url==='/'?'index.html':req.url);
  fs.readFile(f,(e,d)=>{
    if(e){res.writeHead(404);res.end('Not found');return;}
    const ext=path.extname(f);
    const mime={'html':'text/html; charset=utf-8','js':'application/javascript; charset=utf-8','css':'text/css','png':'image/png','jpg':'image/jpeg','mp4':'video/mp4','webm':'video/webm'}[ext.slice(1)]||'application/octet-stream';
    res.writeHead(200,{'Content-Type':mime});res.end(d);
  });
}).listen(PORT,()=>console.log('http://localhost:'+PORT));
