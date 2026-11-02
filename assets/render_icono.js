const puppeteer=require('puppeteer-core');
(async()=>{
  const b=await puppeteer.launch({executablePath:'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',headless:'new',args:['--no-sandbox']});
  const p=await b.newPage();
  await p.setViewport({width:1024,height:1024,deviceScaleFactor:1});
  await p.goto('file://'+process.cwd()+'/icono.html',{waitUntil:'networkidle0'});
  await new Promise(r=>setTimeout(r,400));
  await p.screenshot({path:'icon_1024.png',omitBackground:true,clip:{x:0,y:0,width:1024,height:1024}});
  await b.close();
  console.log('PNG listo');
})();
