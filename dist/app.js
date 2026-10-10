const STORE_KEY='family-rhythm-v1';
const state=JSON.parse(localStorage.getItem(STORE_KEY)||'{"weights":[],"foods":[],"chores":[]}');
const $=s=>document.querySelector(s); const $$=s=>[...document.querySelectorAll(s)];
const dateKey=(d=new Date())=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const prettyDate=iso=>new Date(`${iso}T12:00:00`).toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
const save=()=>{localStorage.setItem(STORE_KEY,JSON.stringify(state));render()};
const toast=t=>{const el=$('#toast');el.textContent=t;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),1800)};

let db;
const dbReady=new Promise((resolve,reject)=>{const req=indexedDB.open('family-rhythm-photos',1);req.onupgradeneeded=()=>req.result.createObjectStore('photos',{keyPath:'id',autoIncrement:true});req.onsuccess=()=>{db=req.result;resolve(db)};req.onerror=()=>reject(req.error)});
async function getPhotos(){await dbReady;return new Promise((res,rej)=>{const r=db.transaction('photos').objectStore('photos').getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
async function addPhoto(file){await dbReady;return new Promise((res,rej)=>{const r=db.transaction('photos','readwrite').objectStore('photos').add({name:file.name,blob:file,addedAt:Date.now()});r.onsuccess=res;r.onerror=()=>rej(r.error)})}

function go(id){$$('.view').forEach(v=>v.classList.toggle('active',v.id===id));$$('.bottom-nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===id));scrollTo({top:0,behavior:'smooth'});render()}
$$('.bottom-nav button').forEach(b=>b.onclick=()=>go(b.dataset.view));$$('[data-go]').forEach(b=>b.onclick=()=>go(b.dataset.go));

function render(){
 const today=dateKey(); const foods=state.foods.filter(x=>x.date===today); const done=state.chores.filter(x=>x.done).length;
 $('#mealCount').textContent=`${foods.length} ${foods.length===1?'entry':'entries'}`; $('#choreSummary').textContent=`${done} of ${state.chores.length}`; $('#todayProgress').textContent=`${foods.length+done} small wins`;
 const dow=new Date().getDay(),scheduled=dow===1||dow===5,logged=state.weights.some(x=>x.date===today); let status='Next weigh-in is '+nextWeighIn();
 if(scheduled&&!logged)status='Today is a weigh-in day. A family photo is waiting.'; if(logged)status='Today’s check-in is complete. Nicely done.'; $('#weighStatus').textContent=status;
 renderWeights();renderFoods();renderChores();renderPhotos();
}
function nextWeighIn(){const d=new Date();for(let i=scheduledToday()?1:0;i<8;i++){const x=new Date(d);x.setDate(d.getDate()+i);if([1,5].includes(x.getDay()))return x.toLocaleDateString(undefined,{weekday:'long',month:'short',day:'numeric'})}}
function scheduledToday(){return[1,5].includes(new Date().getDay())}
function weightCard(w){return `<div class="list-card"><div class="grow"><strong>${w.value} ${w.unit}</strong><small>${prettyDate(w.date)}</small></div><button class="delete" data-delete-weight="${w.id}" aria-label="Delete weigh-in">×</button></div>`}
function renderWeights(){const sorted=[...state.weights].sort((a,b)=>b.date.localeCompare(a.date));$('#recentWeights').innerHTML=sorted.slice(0,3).map(weightCard).join('')||'<div class="empty">Your first gentle check-in will appear here.</div>';$('#weightHistory').innerHTML=sorted.map(weightCard).join('')||'<div class="empty">No weigh-ins yet. Monday and Friday are your check-in days.</div>';$$('[data-delete-weight]').forEach(b=>b.onclick=()=>{state.weights=state.weights.filter(x=>x.id!==b.dataset.deleteWeight);save()})}
function renderFoods(){const sorted=[...state.foods].sort((a,b)=>b.createdAt-a.createdAt);$('#foodList').innerHTML=sorted.map(x=>`<div class="list-card"><div class="grow"><strong>${esc(x.name)}</strong><small>${x.note?esc(x.note)+' · ':''}${prettyDate(x.date)}</small></div><button class="delete" data-delete-food="${x.id}">×</button></div>`).join('')||'<div class="empty">Nothing logged yet. Keep it simple—just add what you ate.</div>';$$('[data-delete-food]').forEach(b=>b.onclick=()=>{state.foods=state.foods.filter(x=>x.id!==b.dataset.deleteFood);save()})}
function renderChores(){$('#choreList').innerHTML=state.chores.map(x=>`<div class="list-card"><button class="check ${x.done?'done':''}" data-toggle-chore="${x.id}">${x.done?'✓':''}</button><div class="grow ${x.done?'completed':''}"><strong>${esc(x.name)}</strong><small>${x.done?'Complete':'Ready when you are'}</small></div><button class="delete" data-delete-chore="${x.id}">×</button></div>`).join('')||'<div class="empty">Your chore list is clear.</div>';$$('[data-toggle-chore]').forEach(b=>b.onclick=()=>{const x=state.chores.find(x=>x.id===b.dataset.toggleChore);x.done=!x.done;save()});$$('[data-delete-chore]').forEach(b=>b.onclick=()=>{state.chores=state.chores.filter(x=>x.id!==b.dataset.deleteChore);save()})}
async function renderPhotos(){const photos=await getPhotos();$('#photoGrid').innerHTML='';for(const p of photos){const img=document.createElement('img');img.src=URL.createObjectURL(p.blob);img.alt=p.name;$('#photoGrid').append(img)}}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}

$('#foodForm').onsubmit=e=>{e.preventDefault();state.foods.push({id:crypto.randomUUID(),name:$('#foodName').value.trim(),note:$('#foodNote').value.trim(),date:dateKey(),createdAt:Date.now()});e.target.reset();save();toast('Food entry added')};
$('#choreForm').onsubmit=e=>{e.preventDefault();state.chores.push({id:crypto.randomUUID(),name:$('#choreName').value.trim(),done:false});e.target.reset();save();toast('Chore added')};
$('#photoInput').onchange=async e=>{for(const f of e.target.files)await addPhoto(f);e.target.value='';renderPhotos();toast('Family photos added')};
const openWeigh=()=>{$('#weightValue').value='';$('#weighDialog').showModal();setTimeout(()=>$('#weightValue').focus(),100)};$('#openWeighIn').onclick=openWeigh;$('#openWeighInLarge').onclick=openWeigh;
$('#weighForm').onsubmit=async e=>{e.preventDefault();const today=dateKey();state.weights=state.weights.filter(x=>x.date!==today);state.weights.push({id:crypto.randomUUID(),date:today,value:Number($('#weightValue').value),unit:$('#weightUnit').value,createdAt:Date.now()});save();$('#weighDialog').close();const photos=await getPhotos();const img=$('#rewardImage'),empty=$('#rewardEmpty');if(photos.length){const p=photos[Math.floor(Math.random()*photos.length)];img.src=URL.createObjectURL(p.blob);img.hidden=false;empty.hidden=true}else{img.hidden=true;empty.hidden=false}$('#reward').hidden=false};
$('#closeReward').onclick=()=>{$('#reward').hidden=true};
$('#todayLabel').textContent=new Date().toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'});render();
