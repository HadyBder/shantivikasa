import model from '../shared/sync-model.cjs';
const {validateProduct,validateSale,fail}=model;
export class Repository{
 constructor(db){this.db=db;}
 async read(){
  const [p,s,r,b]=await this.db.batch([this.db.prepare('SELECT payload FROM cloud_products ORDER BY id'),this.db.prepare('SELECT payload FROM cloud_sales'),this.db.prepare('SELECT COALESCE(MAX(revision),0) AS revision FROM cloud_commits'),this.db.prepare('SELECT id FROM cloud_commits WHERE revision=1')]);
  const revision=r.results[0].revision;
  return{revision,bootstrapId:b.results[0]?.id,initialized:revision>0,snapshot:{products:p.results.map(r=>JSON.parse(r.payload)),sales:s.results.map(r=>JSON.parse(r.payload)).sort((a,b)=>a.number-b.number)}};
 }
 async seen(id){return !!await this.db.prepare('SELECT id FROM cloud_commits WHERE id=?').bind(id).first();}
 async commit(id,revision,products,saleList){
  // A unique revision is the transaction's compare-and-swap guard. A racing
  // writer fails the first statement, rolling the entire D1 batch back.
  const batch=[this.db.prepare('INSERT INTO cloud_commits(revision,id,created_at) VALUES(?,?,?)').bind(revision+1,id,new Date().toISOString())];
  for(const p of products)batch.push(this.db.prepare('INSERT INTO cloud_products(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').bind(p.id,JSON.stringify(p)));
  for(const s of saleList)batch.push(this.db.prepare('INSERT INTO cloud_sales(id,payload) VALUES(?,?)').bind(s.id,JSON.stringify(s)));
  await this.db.batch(batch);
 }
 async bootstrap(body){
  if(typeof body.id!=='string'||!/^[a-f0-9-]{36}$/i.test(body.id))fail('Invalid import ID.');
  if(await this.seen(body.id))return{ok:true};
  const state=await this.read();if(state.initialized)fail('The online register already has data. Import was stopped to protect it.',409);
  const s=body.snapshot;if(!s||!Array.isArray(s.products)||!Array.isArray(s.sales)||s.products.length>10000||s.sales.length>100000)fail('Invalid register backup.');
  s.products.forEach(validateProduct);s.sales.forEach(validateSale);
  if(new Set(s.products.map(p=>p.id)).size!==s.products.length||new Set(s.products.map(p=>p.code)).size!==s.products.length||new Set(s.sales.map(s=>s.id)).size!==s.sales.length||new Set(s.sales.map(s=>s.number)).size!==s.sales.length)fail('The register contains duplicate identifiers.');
  try{await this.commit(body.id,0,s.products,s.sales);}catch(e){if(await this.seen(body.id))return{ok:true};if((await this.read()).initialized)fail('Another device imported the register first. No data was overwritten.',409);throw e;}return{ok:true};
 }
 async mutate(id,build){
  for(let attempt=0;attempt<5;attempt++){
   if(await this.seen(id))return{ok:true,replayed:true};
   const current=await this.read();if(!current.initialized)fail('Connect your Windows register first to import your current inventory.',412);
   const result=build(current.snapshot);
   try{await this.commit(id,current.revision,result.products,result.sale?[result.sale]:[]);return{ok:true,sale:result.sale};}
   catch(e){if(await this.seen(id))return{ok:true,replayed:true};if(/UNIQUE|constraint/i.test(e.message))continue;throw e;}
  }
  fail('The register is busy. Retry; your change will only be saved once.',503);
 }
}
