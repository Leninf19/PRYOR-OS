// ── Semantic complaint / praise categories ────────────────────────────────────
// Phrase-based matching: a review belongs to a category if ANY phrase is found
// as a substring of the lowercase review text. This replaces the old word-
// frequency approach so results reflect real operational issues, not stopwords.

export const COMPLAINT_CATEGORIES = [
  {
    id: 'slow_service',
    label: 'Long Wait / Slow Service',
    icon: '⏱',
    baseSeverity: 'high',
    phrases: [
      'took forever','waited forever','wait forever','long wait','waited a long time',
      'waited so long','waited way too','waited a very long','waited over','waited almost',
      'waited more than','waited an hour','over an hour','over 45 minutes','over 30 minutes',
      'waited 45','waited 40','waited 30','slow service','slow server','slow waiter',
      'slow waitress','took too long','took way too long','took a very long time',
      'took a really long','took a long time','took so long','nobody came to our',
      'no one came to our','never came back to our','never showed up',
      'extremely slow','ridiculously slow','incredibly slow','very slow service',
      'long wait time','wait time was','very long wait','sitting here for',
    ],
  },
  {
    id: 'poor_service',
    label: 'Poor Customer Service',
    icon: '😤',
    baseSeverity: 'high',
    phrases: [
      'rude staff','rude server','rude waiter','rude waitress','rude manager',
      'rude employee','rude workers','rude worker','was very rude','was so rude',
      'extremely rude','incredibly rude','very rude','bad service','terrible service',
      'horrible service','awful service','worst service','poor service',
      'poor customer service','bad customer service','unfriendly staff',
      'unfriendly server','not friendly','wasn\'t friendly','weren\'t friendly',
      'unprofessional','disrespectful','dismissive','condescending',
      'bad attitude','attitude problem','had an attitude','has an attitude',
      'ignored us','ignored me','ignored our table','felt ignored','being ignored',
      'never checked on us','never checked on me','didn\'t check on us',
      'never came back to our table','didn\'t come back to our table',
      'had to wave','had to flag someone','had to get someone\'s attention',
      'had to ask someone','paid no attention','no attention to us',
      'staff was rude','staff were rude','employees were rude','very inattentive',
    ],
  },
  {
    id: 'food_quality',
    label: 'Food Quality',
    icon: '🍽',
    baseSeverity: 'high',
    phrases: [
      'bad food','terrible food','horrible food','awful food','worst food',
      'food was bad','food was terrible','food was horrible','food was awful',
      'food is bad','food is terrible','disgusting food','food was disgusting',
      'food was gross','gross food','overcooked','undercooked','not cooked properly',
      'raw chicken','raw meat','raw fish','burnt food','food was burnt',
      'burned food','food was burned','bland food','food was bland','no flavor',
      'no flavour','tasteless','flavorless','flavourless','had no flavor',
      'had no taste','not fresh','old food','stale food','food was stale',
      'food was old','soggy food','food was soggy','mushy food',
      'tough meat','meat was tough','chewy meat','meat was chewy',
      'quality of the food was','quality was poor','quality was bad',
      'didn\'t taste good','didn\'t taste right','didn\'t enjoy the food',
      'not tasty','not flavorful','food was not good',
    ],
  },
  {
    id: 'cold_food',
    label: 'Cold Food',
    icon: '🥶',
    baseSeverity: 'medium',
    phrases: [
      'cold food','food was cold','food is cold','food came out cold',
      'food arrived cold','food came cold','served cold food','served us cold',
      'lukewarm','luke warm','barely warm','not hot enough','wasn\'t hot',
      'not warm','wasn\'t warm','not even warm','barely hot',
      'cold plate','cold meal','meal was cold','plate was cold',
      'food wasn\'t hot','food wasn\'t warm','food not hot',
      'room temperature food','cold tacos','cold burrito','cold enchiladas',
      'cold tortillas','cold rice','cold beans','food got cold',
    ],
  },
  {
    id: 'wrong_order',
    label: 'Wrong Order / Missing Items',
    icon: '❌',
    baseSeverity: 'high',
    phrases: [
      'wrong order','got the wrong','received the wrong','wrong item','wrong food',
      'incorrect order','order was wrong','order wasn\'t right','order was not right',
      'not what i ordered','not what we ordered','didn\'t order this',
      'they forgot','forgot my rice','forgot my beans','forgot the rice',
      'forgot the beans','forgot the chips','forgot the salsa','forgot our',
      'missing from my order','was missing from','were missing from',
      'missing item','missing items','left out of my order','left off the order',
      'wasn\'t included','not included in my order','incomplete order',
      'missing half my order','wrong drink','wrong sauce','wrong toppings',
      'wrong burrito','wrong taco','they mixed up','mixed up our order',
      'got someone else\'s order','got the wrong food',
    ],
  },
  {
    id: 'food_late',
    label: 'Food Took Too Long',
    icon: '🕐',
    baseSeverity: 'medium',
    phrases: [
      'food took forever','food took too long','food took a long time','food took so long',
      'waited for my food','waited for our food','waited a long time for food',
      'waited a long time for our food','food never came','food didn\'t come',
      'food was late','food arrived late','food came out late',
      'kitchen was slow','kitchen is slow','kitchen took forever',
      'food took over an hour','food took more than','food took about an hour',
      'an hour for food','hour to get food','hour for our food','hour for the food',
      'waited over an hour for food','waited 45 minutes for food',
      'waited 30 minutes for food','food came out cold because it took so long',
    ],
  },
  {
    id: 'small_portions',
    label: 'Small Portions / Poor Value',
    icon: '💰',
    baseSeverity: 'medium',
    phrases: [
      'small portion','tiny portion','portions are small','portion was small',
      'portions were small','very small portion','way too small portion',
      'not enough food','barely any food','not much food','very little food',
      'hardly any meat','barely any meat','very little meat','not enough meat',
      'skimpy portion','small serving','very small serving','little to no meat',
      'overpriced','too expensive','very expensive','way too expensive',
      'not worth the price','not worth the money','not worth it for the price',
      'bad value','poor value','terrible value','not good value',
      'rip off','ripoff','highway robbery',
      'expensive for what you get','expensive for the portion size',
    ],
  },
  {
    id: 'cleanliness',
    label: 'Cleanliness Issues',
    icon: '🧹',
    baseSeverity: 'critical',
    phrases: [
      'dirty restaurant','dirty table','dirty tables','tables were dirty',
      'table was dirty','filthy','so dirty','very dirty','extremely dirty',
      'not clean','wasn\'t clean','wasn\'t very clean','very messy',
      'dirty floor','dirty floors','sticky floor','sticky floors',
      'dirty bathroom','dirty restroom','bathroom was dirty','restroom was dirty',
      'nasty bathroom','filthy bathroom','unclean','not sanitary',
      'bugs','fruit flies','gnats','roach','cockroach','mouse','rodent','pest',
      'smelled bad','smells bad','bad smell','awful smell','horrible smell',
      'not sanitized','unhygienic','unsanitary','health code',
    ],
  },
  {
    id: 'management',
    label: 'Management Issues',
    icon: '👔',
    baseSeverity: 'high',
    phrases: [
      'manager was rude','rude manager','manager had an attitude',
      'manager was not helpful','manager wasn\'t helpful','manager didn\'t help',
      'manager refused','manager wouldn\'t','manager said nothing',
      'couldn\'t find a manager','never got a manager','no manager came',
      'management is terrible','management was terrible','management was awful',
      'management is poor','management is bad','bad management','poor management',
      'owner was rude','rude owner','owner didn\'t care','owner doesn\'t care',
      'complaint was ignored','ignored our complaint','didn\'t care about complaint',
      'nothing was done','nothing was resolved','issue was not resolved',
      'no accountability','no apology','didn\'t apologize','refused to apologize',
      'refused to help','refused to refund','refused to replace','refused to remake',
    ],
  },
  {
    id: 'atmosphere',
    label: 'Atmosphere / Noise',
    icon: '🔊',
    baseSeverity: 'low',
    phrases: [
      'too loud','very loud','extremely loud','so loud','way too loud',
      'loud music','music was too loud','music too loud','music was extremely loud',
      'too noisy','very noisy','so noisy','extremely noisy','incredibly noisy',
      'noisy environment','chaotic atmosphere','hectic','overwhelming noise',
      'bad atmosphere','bad vibe','vibe was off','atmosphere was bad',
      'depressing atmosphere','cold atmosphere','not inviting at all',
    ],
  },
  {
    id: 'drinks',
    label: 'Drinks / Bar Issues',
    icon: '🍹',
    baseSeverity: 'low',
    phrases: [
      'weak drinks','drinks were weak','drink was weak','margarita was weak',
      'weak margarita','weak cocktail','drinks were watered down','watered down drinks',
      'bad margarita','terrible margarita','horrible margarita','worst margarita',
      'watered down','watered-down','mostly ice','all ice','too much ice in the',
      'drinks were bad','bad drinks','drinks were terrible','drinks were awful',
      'drinks took forever','drinks took too long','waited forever for drinks',
      'waited a long time for drinks','wait too long for drinks',
      'overpriced drinks','drinks are overpriced','expensive drinks',
    ],
  },
  {
    id: 'reservation',
    label: 'Reservation Problems',
    icon: '📋',
    baseSeverity: 'medium',
    phrases: [
      'reservation wasn\'t honored','reservation was not honored',
      'didn\'t honor my reservation','lost my reservation',
      'couldn\'t find my reservation','no record of my reservation',
      'had a reservation but still waited','made a reservation but',
      'reservation and still waited','despite having a reservation',
      'even with a reservation we waited','waited despite reservation',
      'our reservation was lost','reservation was ignored',
    ],
  },
  {
    id: 'online_ordering',
    label: 'Online / Delivery Issues',
    icon: '📦',
    baseSeverity: 'medium',
    phrases: [
      'online order was wrong','ordered online and got','online ordering was',
      'app issue','app problem','app didn\'t work','website issue','website problem',
      'uber eats','doordash','grubhub','door dash','delivery app',
      'delivery was late','delivery took too long','delivery never arrived',
      'delivery order was wrong','delivery driver messed up',
      'takeout order was wrong','takeout was wrong','curbside order was wrong',
      'pickup order was wrong',
    ],
  },
  {
    id: 'no_attention',
    label: 'Staff Ignored / No Attention',
    icon: '👻',
    baseSeverity: 'high',
    phrases: [
      'felt invisible','felt like we were invisible','made us feel invisible',
      'no one helped us','nobody helped us','no one acknowledged us',
      'nobody acknowledged us','no one greeted us','nobody greeted us',
      'not greeted','stood there for','standing there waiting',
      'stood at the door for','waited to be seated','standing waiting to be seated',
      'waiting at the door','no one came to seat us','never got seated',
      'couldn\'t get seated','sat at our table for','sat there without anyone',
      'sat for a long time without','nobody checked on us','no one checked on us',
      'never checked on us','couldn\'t get anyone\'s attention',
      'couldn\'t get the server\'s attention',
    ],
  },
  {
    id: 'host_seating',
    label: 'Host & Greeting',
    icon: '🚪',
    baseSeverity: 'medium',
    phrases: [
      'rude host','host was rude','hostess was rude','unfriendly host',
      'unfriendly hostess','host was unwelcoming','host ignored us',
      'host didn\'t greet','front desk was rude','hostess ignored',
      'host stand was disorganized','unorganized host stand',
      'host was not helpful','host was unhelpful',
    ],
  },
  {
    id: 'carryout',
    label: 'Carryout / Takeout',
    icon: '📦',
    baseSeverity: 'medium',
    phrases: [
      'carryout order was wrong','takeout order was wrong','takeout order was missing',
      'pickup order was wrong','order wasn\'t ready when','waited for my takeout',
      'carryout was cold','togo order incorrect','to go order was wrong',
      'forgot items in my takeout','pickup order missing','my carryout order was',
      'takeout was incorrect','curbside order was wrong',
    ],
  },
  {
    id: 'delivery',
    label: 'Delivery',
    icon: '🛵',
    baseSeverity: 'medium',
    phrases: [
      'delivery was late','delivery never arrived','uber eats order','doordash order',
      'grubhub order','delivery driver','arrived cold from delivery',
      'delivery order was wrong','delivery took forever','never delivered',
      'third party delivery','delivery was missing',
    ],
  },
  {
    id: 'maintenance',
    label: 'Facility & Maintenance',
    icon: '🔧',
    baseSeverity: 'medium',
    phrases: [
      'broken chair','broken table','ac wasn\'t working','air conditioning broken',
      'heater wasn\'t working','broken booth','torn seats','leaking roof',
      'broken door','flickering lights','broken sign','run down',
      'needs renovation','outdated decor','falling apart','sink was broken',
      'toilet was broken',
    ],
  },
]

export const PRAISE_CATEGORIES = [
  {
    id: 'fast_service',
    label: 'Fast Service',
    icon: '⚡',
    phrases: [
      'fast service','quick service','speedy service','service was fast',
      'service was quick','served quickly','served fast','prompt service',
      'service was prompt','food came out fast','food came out quickly',
      'food came out so fast','didn\'t wait long','short wait','no wait at all',
      'very quick','so fast','got our food fast','got our food quickly',
      'came out right away','came out immediately',
    ],
  },
  {
    id: 'friendly_staff',
    label: 'Friendly / Attentive Staff',
    icon: '😊',
    phrases: [
      'friendly staff','staff was friendly','staff were friendly','staff is friendly',
      'friendly server','friendly waiter','friendly waitress','friendly service',
      'staff was amazing','staff were amazing','amazing staff',
      'wonderful staff','staff was wonderful','great staff','staff was great',
      'kind staff','staff was kind','very kind staff','so kind and',
      'warm welcome','very welcoming','made us feel welcome','made me feel welcome',
      'attentive staff','staff was attentive','very attentive server',
      'helpful staff','staff was helpful','staff were helpful',
      'very accommodating','extremely accommodating',
      'nice staff','staff were nice','nicest staff',
    ],
  },
  {
    id: 'great_food',
    label: 'Delicious Food',
    icon: '😋',
    phrases: [
      'delicious food','food was delicious','food is delicious',
      'amazing food','food was amazing','food is amazing',
      'best food','food was the best','great food','food was great',
      'excellent food','food was excellent','fantastic food','food was fantastic',
      'wonderful food','food was wonderful','food was incredible','incredible food',
      'food was outstanding','outstanding food','food was superb',
      'so good','food was so good','food is so good','really good food',
      'loved the food','love the food','love their food','loved their food',
      'food did not disappoint','food was on point','food hit the spot',
      'everything was delicious','everything tasted amazing',
    ],
  },
  {
    id: 'great_margaritas',
    label: 'Great Margaritas / Drinks',
    icon: '🍹',
    phrases: [
      'great margaritas','amazing margaritas','best margaritas','love the margaritas',
      'love their margaritas','margaritas are great','margaritas are amazing',
      'margaritas were great','margaritas were amazing','margaritas are the best',
      'great drinks','amazing drinks','best drinks','drinks were great',
      'drinks are great','drinks were amazing','drinks are amazing','love the drinks',
      'best margarita','great margarita','amazing margarita','delicious margarita',
      'margarita was perfect','perfect margarita',
    ],
  },
  {
    id: 'authentic_food',
    label: 'Authentic Mexican Food',
    icon: '🌮',
    phrases: [
      'authentic mexican food','authentic food','authentic flavors','authentic cuisine',
      'traditional mexican','traditional food','real mexican food','genuinely mexican',
      'taste of mexico','feels like mexico','reminds me of mexico',
      'homemade','home cooked','home-cooked','made from scratch',
      'real tacos','real mexican','like back home','traditional recipes',
      'real deal','the real deal','genuine mexican',
    ],
  },
  {
    id: 'fresh_ingredients',
    label: 'Fresh Food & Ingredients',
    icon: '🌿',
    phrases: [
      'fresh chips','fresh tortillas','fresh salsa','fresh guacamole',
      'fresh ingredients','fresh food','made fresh','freshly made',
      'everything was fresh','very fresh','so fresh','ingredients were fresh',
      'high quality ingredients','quality ingredients','fresh and delicious',
      'obviously fresh','clearly fresh','chips were fresh','tortillas were fresh',
    ],
  },
  {
    id: 'large_portions',
    label: 'Large Portions / Great Value',
    icon: '💪',
    phrases: [
      'large portions','big portions','generous portions','huge portions',
      'portion was large','portions are large','portions are huge','portions are big',
      'great value','good value','excellent value','amazing value','best value',
      'worth the price','worth every penny','worth the money','very affordable',
      'affordable prices','reasonably priced','reasonable price','good prices',
      'great price','great deal','can\'t beat the price','best bang for your buck',
    ],
  },
  {
    id: 'great_atmosphere',
    label: 'Great Atmosphere / Ambiance',
    icon: '✨',
    phrases: [
      'great atmosphere','amazing atmosphere','love the atmosphere','wonderful atmosphere',
      'great vibe','amazing vibe','love the vibe','great ambiance','amazing ambiance',
      'beautiful restaurant','beautiful patio','nice patio','great patio',
      'cozy','nice and cozy','warm atmosphere','lively atmosphere',
      'fun atmosphere','great place to','love this place','love the place',
      'beautiful decor','nice decor','love the decor','cute restaurant',
      'great setting','beautiful setting',
    ],
  },
  {
    id: 'family_friendly',
    label: 'Family Friendly',
    icon: '👨‍👩‍👧',
    phrases: [
      'family friendly','family-friendly','great for families','perfect for families',
      'great for the whole family','kids loved it','kids love it','children loved it',
      'great for kids','good for kids','kids menu','kid friendly',
      'brought the whole family','came with family','family restaurant',
      'great for a family dinner','family atmosphere','great for children',
    ],
  },
  {
    id: 'cleanliness_praise',
    label: 'Clean & Well-Maintained',
    icon: '✅',
    phrases: [
      'very clean','super clean','extremely clean','spotless','immaculate',
      'restaurant was clean','clean restaurant','always clean','kept very clean',
      'clean tables','clean bathrooms','clean environment','clean and tidy',
      'well maintained','well kept','well-maintained','kept clean',
    ],
  },
  {
    id: 'outstanding_server',
    label: 'Outstanding Server',
    icon: '⭐',
    phrases: [
      'amazing server','server was amazing','our server was amazing',
      'best server','server was the best','greatest server',
      'wonderful server','server was wonderful','server was fantastic',
      'server went above and beyond','went above and beyond for us',
      'server was so attentive','server checked on us frequently',
      'server was very helpful','our waiter was amazing','our waitress was amazing',
      'waiter was the best','waitress was the best','great waiter',
      'great waitress','server made our experience','server was incredible',
    ],
  },
  {
    id: 'great_takeout',
    label: 'Great Takeout / Delivery',
    icon: '📦',
    phrases: [
      'great takeout','takeout was great','takeout is great','love their takeout',
      'pickup was easy','easy pickup','order was ready on time','order was right',
      'online order was great','online order was perfect',
      'delivery was fast','fast delivery','quick delivery','delivery was great',
      'delivery was on time','delivery arrived quickly','great delivery',
    ],
  },
  {
    id: 'great_management',
    label: 'Excellent Management',
    icon: '👔',
    phrases: [
      'manager was great','manager was wonderful','manager was amazing',
      'manager was very helpful','manager took care of us','manager went above and beyond',
      'great management','excellent management','manager was fantastic',
      'owner was great','owner was very kind','management was excellent',
    ],
  },
  {
    id: 'great_host',
    label: 'Warm Welcome',
    icon: '🚪',
    phrases: [
      'host was great','host was wonderful','hostess was great','hostess was wonderful',
      'great host','friendly host','friendly hostess','warm welcome',
      'greeted us warmly','host was very friendly','hostess was very friendly',
      'seated us right away','host sat us immediately',
    ],
  },
  {
    id: 'well_maintained',
    label: 'Well-Maintained Facility',
    icon: '🔧',
    phrases: [
      'well maintained','well kept','well-maintained','kept up nicely',
      'nicely renovated','recently renovated','modern and clean',
      'facility was great','building was well kept','nice and updated',
    ],
  },
]

// ── Core matching ─────────────────────────────────────────────────────────────

function matchCategories(text, categories) {
  const lower = text.toLowerCase()
  const matched = []
  for (const cat of categories) {
    if (cat.phrases.some(p => lower.includes(p))) {
      matched.push(cat.id)
    }
  }
  return matched
}

// ── Severity calculation ──────────────────────────────────────────────────────

const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical']

function computeSeverity(count, total, baseSeverity) {
  const pct = total > 0 ? count / total : 0
  let dynamic
  if (pct >= 0.30) dynamic = 'critical'
  else if (pct >= 0.18) dynamic = 'high'
  else if (pct >= 0.09) dynamic = 'medium'
  else dynamic = 'low'
  // Take the higher of dynamic and baseSeverity
  const dynamicIdx = SEVERITY_ORDER.indexOf(dynamic)
  const baseIdx    = SEVERITY_ORDER.indexOf(baseSeverity)
  return SEVERITY_ORDER[Math.max(dynamicIdx, baseIdx)]
}

// ── Category summary builder ──────────────────────────────────────────────────
// Returns enriched category array sorted by count desc, filtered to count >= minCount.

export function buildCategorySummary(reviews, categories, prevReviews = [], minCount = 2) {
  // Tag once up-front for performance
  const tagged     = reviews.map(r => ({ ...r, _ids: r.review_text ? matchCategories(r.review_text, categories) : [] }))
  const prevTagged = prevReviews.map(r => ({ ...r, _ids: r.review_text ? matchCategories(r.review_text, categories) : [] }))
  const total = reviews.length

  return categories
    .map(cat => {
      const matched = tagged.filter(r => r._ids.includes(cat.id))
      if (matched.length < minCount) return null

      const prevMatched = prevTagged.filter(r => r._ids.includes(cat.id))

      // Location breakdown (top 5)
      const locCounts = {}
      matched.forEach(r => { locCounts[r.location_name] = (locCounts[r.location_name] || 0) + 1 })
      const topLocations = Object.entries(locCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => ({ name, count }))

      // Example reviews — pick from varied locations
      const examples = []
      const usedLocs = new Set()
      for (const r of matched) {
        if (!r.review_text) continue
        if (!usedLocs.has(r.location_name)) {
          examples.push(r)
          usedLocs.add(r.location_name)
        }
        if (examples.length >= 3) break
      }
      if (examples.length < 3) {
        for (const r of matched) {
          if (r.review_text && !examples.includes(r)) {
            examples.push(r)
            if (examples.length >= 3) break
          }
        }
      }

      // Trend
      const prev = prevMatched.length
      const curr = matched.length
      const trend =
        prev === 0 ? 'new'
        : curr > prev * 1.15 ? 'up'
        : curr < prev * 0.85 ? 'down'
        : 'stable'

      const severity = computeSeverity(curr, total, cat.baseSeverity)
      const avgStar = matched.reduce((s, r) => s + Number(r.star_rating), 0) / curr

      return {
        ...cat,
        count: curr,
        prevCount: prev,
        avgStar: +avgStar.toFixed(2),
        severity,
        topLocations,
        examples,
        trend,
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.count - a.count)
}

// ── Smart summary generator ───────────────────────────────────────────────────

export function generateVocSummary(complaints, praise, totalNeg, totalPos) {
  const parts = []

  if (complaints.length > 0) {
    const top = complaints[0]
    const pct = totalNeg > 0 ? Math.round(top.count / totalNeg * 100) : 0
    let msg = `${top.label} is the most reported issue — mentioned in ${top.count} negative reviews (${pct}% of all 1–2★ reviews in this period)`
    if (top.trend === 'up')   msg += `, and it\'s increasing`
    else if (top.trend === 'down') msg += `, and it\'s improving`
    if (top.topLocations.length > 0) {
      const locNames = top.topLocations.slice(0, 2).map(l =>
        l.name.replace('Los Tres Amigos ','LTA ').replace('Los Tres Mex Grill ','LTMG ')
      )
      msg += `. Most affected: ${locNames.join(', ')}`
    }
    parts.push(msg + '.')

    const criticalIssues = complaints.filter(c => c.severity === 'critical')
    if (criticalIssues.length > 0 && criticalIssues[0].id !== top.id) {
      parts.push(`Critical alert: ${criticalIssues[0].label} was flagged in ${criticalIssues[0].count} reviews.`)
    }
  } else {
    parts.push(`No recurring complaints detected in this period — great sign!`)
  }

  if (praise.length > 0) {
    const topPraise = praise.slice(0, 2).map(p => p.label.toLowerCase())
    parts.push(`Customers most frequently praise ${topPraise.join(' and ')} (${praise[0].count} mentions).`)
  }

  return parts.join(' ')
}

// ── Backward-compatible extractInsights (used by LocationDetail InsightPanel) ─
// Returns the same shape as before but with meaningful category labels.

export function extractInsights(reviews) {
  const positive = reviews.filter(r => Number(r.star_rating) >= 4)
  const negative = reviews.filter(r => Number(r.star_rating) <= 2)

  const positiveThemes = buildCategorySummary(positive, PRAISE_CATEGORIES, [], 1)
    .slice(0, 8)
    .map(c => ({ theme: `${c.icon} ${c.label}`, count: c.count, reviews: c.examples }))

  const complaints = buildCategorySummary(negative, COMPLAINT_CATEGORIES, [], 1)
    .slice(0, 8)
    .map(c => ({ theme: `${c.icon} ${c.label}`, count: c.count, reviews: c.examples }))

  return {
    positiveThemes,
    complaints,
    staffNames: findStaffNames(reviews),
    menuItems:  findMenuItems(reviews),
  }
}

// ── Staff name detection ──────────────────────────────────────────────────────

export const MENU_ITEMS = [
  'tacos','taco','enchiladas','enchilada','fajitas','fajita','burrito','burritos',
  'margarita','margaritas','chips','salsa','guacamole','nachos','quesadilla',
  'quesadillas','tamales','tamale','carnitas','carne asada','al pastor','pollo',
  'rice','beans','chimichanga','chimichangas','tostada','tostadas','torta','tortas',
  'menudo','pozole','birria','mole','churros','churro','sopas','sopa','chile relleno',
  'chile rellenos','flautas','flauta','taquitos','taquito','elote','horchata',
  'jarritos','tres leches','flan','street tacos','fish tacos',
  'shrimp','chicken','pork','beef','queso','pico','cilantro','lime',
]

const STAFF_PATTERNS = [
  /(?:our|my)\s+(?:server|waiter|waitress|bartender|host|manager|girl|guy)\s+([A-Z][a-z]+)/g,
  /(?:server|waiter|waitress|bartender|host|manager)\s+(?:named?\s+)?([A-Z][a-z]+)/g,
  /(?:ask for|shoutout to|thanks? to|kudos to|great job)\s+([A-Z][a-z]+)/g,
  /([A-Z][a-z]+)\s+(?:was our|is our|helped us|was amazing|was great|was wonderful|was fantastic|was awesome)/g,
]

const NAME_DENYLIST = new Set([
  'english','spanish','mexican','american','great','good','amazing','awesome',
  'wonderful','fantastic','excellent','perfect','friendly','attentive','quick',
  'fast','slow','rude','nice','super','very','extremely','always','definitely',
  'absolutely','overall','honestly','seriously','today','yesterday','monday',
  'tuesday','wednesday','thursday','friday','saturday','sunday','january',
  'february','march','april','may','june','july','august','september',
  'october','november','december','manager','server','waiter','waitress',
  'bartender','host','hostess',
])

export function findStaffNames(reviews) {
  const counts = {}
  const byName = {}
  reviews.forEach(r => {
    const text = r.review_text
    if (!text) return
    STAFF_PATTERNS.forEach(pattern => {
      const re = new RegExp(pattern.source, 'g')
      let m
      while ((m = re.exec(text)) !== null) {
        const name = m[1]
        if (!name || name.length < 2) continue
        if (NAME_DENYLIST.has(name.toLowerCase())) continue
        if (!counts[name]) { counts[name] = 0; byName[name] = [] }
        counts[name]++
        if (byName[name].length < 3) byName[name].push(r)
      }
    })
  })
  return Object.entries(counts)
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count, reviews: byName[name] }))
}

export function findMenuItems(reviews) {
  const found = {}
  reviews.forEach(r => {
    if (!r.review_text) return
    const text = r.review_text.toLowerCase()
    MENU_ITEMS.forEach(item => {
      if (text.includes(item)) {
        if (!found[item]) found[item] = { item, count: 0, reviews: [] }
        found[item].count++
        if (found[item].reviews.length < 3) found[item].reviews.push(r)
      }
    })
  })
  return Object.values(found)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
}
