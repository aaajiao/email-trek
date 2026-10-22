/**
 * Created by Elvis on 15/10/22.
 */
let ChineseName = require("chinese-name"),
  JapaneseName = require("../japanese-names-generator"),
  EnglishName = require("../english-names-generator"),
  pinyin = require("pinyin");

let enMailAdds = {
  "@outlook.com": 11,
  "@yahoo.com": 56,
  "@gmail.com": 79,
  "@hotmail.com": 49,
  "@aol.com": 6,
};

let cnMailAdds = {
  "@gmail.com": 31,
  "@outlook.com": 6,
  "@hotmail.com": 8,
  "@163.com": 9,
  "@qq.com": 12,
  "@sina.com": 3,
  "@sohu.com": 1,
  "@263.com": 1,
};

let jpMailAdds = {
  "@gmail.com": 43,
  "@hotmail.com": 29,
  "@outlook.com": 9,
  "@yahoo.co.jp": 8,
  "@goo.ne.jp": 1,
};

let rand = function (l) {
  return Math.random() * l;
};

let getRandomMailAddr = function (list) {
  let total_weight = 0;
  for (let k in list) {
    total_weight += list[k];
  }
  let random_num = rand(total_weight);
  let weight_sum = 0;

  for (let k in list) {
    weight_sum += list[k];
    if (random_num <= weight_sum) {
      return k;
    }
  }
};

let getRandomInt = function (min, max) {
  return Math.floor(Math.random() * (max + 1 - min) + min);
};

let getRandomJoin = function () {
  let joinStr;
  let r = Math.random();
  if (r < 0.5) {
    joinStr = ".";
  } else if (r < 0.7) {
    joinStr = "-";
  } else if (r < 0.9) {
    joinStr = "_";
  } else {
    joinStr = "";
  }
  return joinStr;
};

let getRandomDate = function (fromDate, toDate) {
  let diff = toDate.getTime() - fromDate.getTime();
  let new_diff = diff * Math.random();
  let date = new Date(fromDate.getTime() + new_diff);
  let year = date.getFullYear().toString().substr(2, 2);
  let month = date.getMonth() + 1;
  month = month > 9 ? (month = month.toString()) : "0" + month.toString();
  let day = date.getDate();
  day = day > 9 ? (day = day.toString()) : "0" + day.toString();

  return Math.random() < 0.33 ? year + month + day : year;
};

let generateChineseName = function () {
  let name = ChineseName.random();
  let py;
  switch (getRandomInt(0, 1)) {
    case 0:
      py = pinyin(name, {
        style: pinyin.STYLE_NORMAL,
      }).join("");
      break;
    case 1:
      py = pinyin(name, {
        style: pinyin.STYLE_FIRST_LETTER,
      }).join("");
      break;
  }
  if (py.length < 5) {
    if (Math.random() < 0.5) {
      py += getRandomDate(new Date("1965"), new Date("2006"));
    }
  } else {
    if (Math.random() < 0.1) {
      py += getRandomDate(new Date("1965"), new Date("2006"));
    }
  }
  return py;
};

let generateJapaneseName = function () {
  return JapaneseName.AllName();
};

let generateEnglishName = function () {
  return EnglishName.AllName();
};

let generateMixedName = function () {
  let sur = pinyin(ChineseName.random(), {
    style: pinyin.STYLE_NORMAL,
  })[0].join("");
  return EnglishName.FirstName() + getRandomJoin() + sur;
};

let generateEmailAddr = function () {
  let r = Math.random();
  if (r < 0.25) {
    return generateChineseName() + getRandomMailAddr(cnMailAdds);
  } else if (r < 0.9) {
    return generateEnglishName() + getRandomMailAddr(enMailAdds);
  } else if (r < 0.95) {
    return generateJapaneseName() + getRandomMailAddr(jpMailAdds);
  } else if (r < 0.97) {
    return generateMixedName() + getRandomMailAddr(cnMailAdds);
  } else {
    return generateMixedName() + getRandomMailAddr(enMailAdds);
  }
};

//for (let i=0;i<100;i++) {
//	console.log(generateEmailAddr());
//}

module.exports = {
  gen: function () {
    return generateEmailAddr().toLowerCase();
  },
};
