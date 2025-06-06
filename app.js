const express = require('express');
const mysql = require('mysql');
const session = require('express-session');
const bcrypt = require('bcrypt');
const app = express();

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: false }));

// セッション設定
app.use(
  session({
    secret: 'secret_key',
    resave: false,
    saveUninitialized: false,
  })
);

require('dotenv').config();  // .envファイルを読み込む
// MySQL接続
const connection = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: process.env.DB_PASSWORD,
  database: 'es_management'
});

// 接続チェック
connection.connect((err) => {
  if (err) {
    console.error('MySQL接続エラー:', err);
    throw err;
  }
  console.log('MySQL接続成功');
});

app.use((req, res, next) => {
  if (req.session.userId === undefined) {
    res.locals.username = 'ゲスト';
    res.locals.isLoggedIn = false;
  } else {
    res.locals.username = req.session.username;
    res.locals.isLoggedIn = true;
  }
  next();
});

// トップページ
app.get('/', (req, res) => {
  res.render('top.ejs');
});

// ユーザー登録ページ
app.get('/signup', (req, res) => {
  res.render('signup.ejs', { errors: [] });
});

// ユーザー登録処理
app.post('/signup',
  (req, res, next) => {
    const { username, email, password } = req.body;
    const errors = [];

    if (!username) errors.push('ユーザー名が空です');
    if (!email) errors.push('メールアドレスが空です');
    if (!password) errors.push('パスワードが空です');

    if (errors.length > 0) {
      return res.render('signup.ejs', { errors });
    }
    next();
  },
  (req, res, next) => {
    const { email } = req.body;
    connection.query('SELECT * FROM users WHERE email = ?', [email], (error, results) => {
      if (results.length > 0) {
        return res.render('signup.ejs', { errors: ['メールアドレスは既に登録されています'] });
      }
      next();
    });
  },
  (req, res) => {
    const { username, email, password } = req.body;
    bcrypt.hash(password, 10, (error, hash) => {
      connection.query(
        'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
        [username, email, hash],
        (error, results) => {
          if (error) throw error;
          req.session.userId = results.insertId;
          req.session.username = username;
          res.redirect('/companies');
        }
      );
    });
  }
);

// ログインページ
app.get('/login', (req, res) => {
  res.render('login.ejs');
});

// ログイン処理
app.post('/login', (req, res) => {
  const { email, password } = req.body;
  connection.query('SELECT * FROM users WHERE email = ?', [email], (error, results) => {
    if (results.length > 0) {
      const hash = results[0].password;
      bcrypt.compare(password, hash, (error, isEqual) => {
        if (isEqual) {
          req.session.userId = results[0].id;
          req.session.username = results[0].username;
          res.redirect('/companies');
        } else {
          res.redirect('/login');
        }
      });
    } else {
      res.redirect('/login');
    }
  });
});

// ログアウト処理
app.get('/logout', (req, res) => {
  req.session.destroy((error) => {
    res.redirect('/');
  });
});


app.get('/companies', (req, res) => {
  const userId = req.session.userId;

  // クエリパラメータ取得
  const { industry, selection_type, status } = req.query;

  // ベースSQLとパラメータ配列
  let sqlCompany = "SELECT * FROM companies WHERE user_id = ?";
  const params = [userId];

  // 条件があれば追加
  if (industry && industry.trim() !== '') {
    sqlCompany += " AND industry = ?";
    params.push(industry.trim());
  }
  if (selection_type && selection_type.trim() !== '') {
    sqlCompany += " AND selection_type = ?";
    params.push(selection_type.trim());
  }
  if (status && status.trim() !== '') {
    sqlCompany += " AND status = ?";
    params.push(status.trim());
  }

  // 企業データと選択肢候補を同時に取得
  connection.query(sqlCompany, params, (err, companies) => {
    if (err) return res.status(500).send("企業取得エラー");

    // フィルター項目の候補は user_id だけで取得
    const sqlIndustry = "SELECT DISTINCT industry FROM companies WHERE user_id = ?";
    const sqlType = "SELECT DISTINCT selection_type FROM companies WHERE user_id = ?";
    const sqlStatus = "SELECT DISTINCT status FROM companies WHERE user_id = ?";

    connection.query(sqlIndustry, [userId], (err, industries) => {
      if (err) return res.status(500).send("業界取得エラー");

      connection.query(sqlType, [userId], (err, types) => {
        if (err) return res.status(500).send("選考種別取得エラー");

        connection.query(sqlStatus, [userId], (err, statuses) => {
          if (err) return res.status(500).send("ステータス取得エラー");

          res.render("companies", {
            companies,
            industries: industries
              .map(row => row.industry)
              .filter(i => i && i.trim() !== ''), // 空の選択肢を除外
            types: types
              .map(row => row.selection_type)
              .filter(t => t && t.trim() !== ''),
            statuses: statuses
              .map(row => row.status)
              .filter(s => s && s.trim() !== ''),
            selectedIndustry: industry || '',
            selectedType: selection_type || '',
            selectedStatus: status || '',
          });
        });
      });
    });
  });
});



// 企業追加
app.post('/companies/add', (req, res) => {
  const { company_name, industry, selection_type, status } = req.body;
  const userId = req.session.userId;

  const trimmedIndustry = industry.trim();
  const trimmedSelectionType = selection_type.trim();
  const trimmedStatus = status.trim();

  // 企業名の重複チェック
  connection.query("SELECT * FROM companies WHERE name = ?", [company_name], (err, results) => {
    if (err) {
      console.error("企業検索エラー:", err);
      return res.status(500).send("エラーが発生しました");
    }

    if (results.length > 0) {
      return res.status(400).send("この企業はすでに登録されています。");
    }

    // INSERTの準備（空白のみだった場合はNULLにする）
    const query = `
      INSERT INTO companies (name, industry, selection_type, status, user_id)
      VALUES (?, ?, ?, ?, ?)
    `;
    const values = [
      company_name,
      trimmedIndustry || null,
      trimmedSelectionType || null,
      trimmedStatus || null,
      req.session.userId
    ];

    connection.query(query, values, (err) => {
      if (err) {
        console.error("企業追加エラー:", err);
        return res.status(500).send("エラーが発生しました");
      }

      console.log("企業追加成功");
      res.redirect('/companies');
    });
  });
});



//企業編集
app.post('/companies/edit/:id', (req, res) => {
  const companyId = req.params.id;
  const { name, industry, selection_type, status } = req.body;

  const updateQuery = `
    UPDATE companies
    SET name = ?, industry = ?, selection_type = ?, status = ?
    WHERE id = ?
  `;

  connection.query(updateQuery, [name, industry, selection_type, status, companyId], (err, result) => {
    if (err) {
      console.error('企業情報の更新に失敗:', err);
      return res.status(500).send('サーバーエラーが発生しました');
    }
    res.redirect('/companies'); // 編集完了後に一覧へリダイレクト
  });
});

//企業データの削除（関連データ含めて）
app.post('/companies/delete/:id', (req, res) => {
  const companyId = req.params.id;

  connection.beginTransaction(err => {
    if (err) {
      console.error("トランザクション開始エラー:", err);
      return res.status(500).send("削除処理の開始に失敗しました");
    }

    // 1. 回答削除（その企業の質問に紐づく）
    const deleteAnswers = `
      DELETE FROM answers
      WHERE question_id IN (SELECT id FROM questions WHERE company_id = ?)
    `;
    connection.query(deleteAnswers, [companyId], (err) => {
      if (err) {
        return connection.rollback(() => {
          console.error("回答削除エラー:", err);
          res.status(500).send("回答データの削除に失敗しました");
        });
      }

      // 2. 質問削除
      connection.query("DELETE FROM questions WHERE company_id = ?", [companyId], (err) => {
        if (err) {
          return connection.rollback(() => {
            console.error("質問削除エラー:", err);
            res.status(500).send("質問データの削除に失敗しました");
          });
        }

        // 3. 企業削除（user_id も確認）
        connection.query("DELETE FROM companies WHERE id = ? AND user_id = ?", [companyId, req.session.userId], (err) => {
          if (err) {
            return connection.rollback(() => {
              console.error("企業削除エラー:", err);
              res.status(500).send("企業データの削除に失敗しました");
            });
          }

          // 4. コミットして確定
          connection.commit(err => {
            if (err) {
              return connection.rollback(() => {
                console.error("コミットエラー:", err);
                res.status(500).send("削除の確定に失敗しました");
              });
            }

            console.log("企業データ削除完了（関連データ含む）");
            res.sendStatus(200);
          });
        });
      });
    });
  });
});



// 企業ごとの質問と回答リスト
app.get('/company/:id', (req, res) => {
  const companyId = req.params.id;

  // 企業情報を取得
  const companyQuery = 'SELECT * FROM companies WHERE id = ? AND user_id = ?';

  // カテゴリ一覧を取得
  const categoriesQuery = 'SELECT * FROM categories WHERE user_id = ?';

  // 質問とその回答を取得（LEFT JOINで回答がなくても表示されるようにする）
  const questionsQuery = `
    SELECT q.id AS question_id, q.question_text, q.max_length, c.id AS category_id, c.name AS category_name, 
           a.id AS answer_id, a.answer_text
    FROM questions q
    JOIN categories c ON q.category_id = c.id
    LEFT JOIN answers a ON q.id = a.question_id
    WHERE q.company_id = ?`;

  connection.query(companyQuery, [companyId, req.session.userId], (error, companyResults) => {
    if (error) {
      console.error(error);
      res.status(500).send("企業データ取得エラー");
      return;
    }
    if (companyResults.length === 0) {
      res.status(404).send("企業が見つかりません");
      return;
    }

    const company = companyResults[0];

    connection.query(questionsQuery, [companyId], (error, questionsResults) => {
      if (error) {
        console.error(error);
        res.status(500).send("質問データ取得エラー");
        return;
      }

      // カテゴリ一覧を取得
      connection.query(categoriesQuery, [req.session.userId], (error, categoriesResults) => {
        if (error) {
          console.error(error);
          res.status(500).send("カテゴリデータ取得エラー");
          return;
        }

        res.render('company_questions.ejs', {
          company: company,
          questions: questionsResults,
          categories: categoriesResults // カテゴリ一覧
        });
      });
    });
  });
});

//質問追加
app.post('/questions/add', (req, res) => {
  const { company_id, question_text, category_name, new_category, max_length } = req.body;
  const user_id = req.session.userId;

  if (!company_id || !question_text || (!category_name && !new_category)) {
    res.status(400).send("企業ID、質問内容、カテゴリ名が必要です");
    return;
  }

  const finalCategory = new_category ? new_category : category_name;

  function getCategoryId(callback) {
    // ユーザーに紐づいたカテゴリを検索
    const categoryQuery = 'SELECT id FROM categories WHERE name = ? AND user_id = ?';
    connection.query(categoryQuery, [finalCategory, user_id], (error, results) => {
      if (error) {
        console.error(error);
        res.status(500).send("カテゴリ取得に失敗しました");
        return;
      }

      if (results.length > 0) {
        callback(results[0].id);
      } else {
        // 存在しない場合、カテゴリを追加（user_id付きで）
        const insertCategoryQuery = 'INSERT INTO categories (name, user_id) VALUES (?, ?)';
        connection.query(insertCategoryQuery, [finalCategory, user_id], (error, result) => {
          if (error) {
            console.error(error);
            res.status(500).send("カテゴリ追加に失敗しました");
            return;
          }
          callback(result.insertId);
        });
      }
    });
  }

  getCategoryId((category_id) => {
    const insertQuery = `
      INSERT INTO questions (company_id, question_text, category_id, max_length, user_id)
      VALUES (?, ?, ?, ?, ?)
    `;
    connection.query(insertQuery, [company_id, question_text, category_id, max_length || null, user_id], (error) => {
      if (error) {
        console.error(error);
        res.status(500).send("質問の追加に失敗しました");
        return;
      }
      res.redirect(`/company/${company_id}`);
    });
  });
});


//質問の編集
app.post('/questions/edit/:question_id', (req, res) => {
  const { question_text, category_name, new_category, max_length, company_id } = req.body;
  const { question_id } = req.params;
  const user_id = req.session.userId;

  if (!question_text) {
    res.status(400).send("質問内容が必要です");
    return;
  }

  if (new_category) {
    // 新しいカテゴリを作成して、そのIDを取得
    const insertCategoryQuery = 'INSERT INTO categories (name, user_id) VALUES (?, ?)';
    connection.query(insertCategoryQuery, [new_category, user_id], (error, categoryResult) => {
      if (error) {
        console.error(error);
        res.status(500).send("カテゴリの追加に失敗しました");
        return;
      }
      const newCategoryId = categoryResult.insertId;
      updateQuestion(question_id, question_text, newCategoryId, max_length, company_id, res);
    });
  } else {
    const categoryQuery = 'SELECT id FROM categories WHERE name = ? AND user_id = ?';
    connection.query(categoryQuery, [category_name, user_id], (error, results) => {
      if (error) {
        console.error(error);
        res.status(500).send("カテゴリの取得に失敗しました");
        return;
      }

      if (results.length > 0) {
        const existingCategoryId = results[0].id;
        updateQuestion(question_id, question_text, existingCategoryId, max_length, company_id, res);
      } else {
        res.status(400).send("指定されたカテゴリが見つかりません");
      }
    });
  }
});

// 質問を更新する共通関数
function updateQuestion(question_id, question_text, category_id, max_length, company_id, res) {
  const updateQuery = 'UPDATE questions SET question_text = ?, category_id = ?, max_length = ? WHERE id = ?';
  connection.query(updateQuery, [question_text, category_id, max_length || null, question_id], (error) => {
    if (error) {
      console.error(error);
      res.status(500).send("質問の編集に失敗しました");
      return;
    }
    res.redirect(`/company/${company_id}`);
  });
}

app.post('/questions/delete/:question_id', (req, res) => {
  const { question_id } = req.params;
  const { company_id } = req.body;

  const deleteQuery = 'DELETE FROM questions WHERE id = ?';
  connection.query(deleteQuery, [question_id], (error) => {
    if (error) {
      console.error(error);
      res.status(500).send("質問の削除に失敗しました");
      return;
    }
    res.redirect(`/company/${company_id}`);
  });
});

//回答を追加、更新する処理
app.post('/answers/add', (req, res) => {
  const { question_id, answer_text } = req.body;
  const user_id = req.session.userId;

  if (!question_id || !answer_text) {
    res.status(400).send("質問IDと回答内容が必要です");
    return;
  }

  // **1. まず、company_id を取得**
  const getCompanyQuery = 'SELECT company_id FROM questions WHERE id = ?';

  connection.query(getCompanyQuery, [question_id], (error, companyResults) => {
    if (error || companyResults.length === 0) {
      console.error(error || "質問が見つかりません");
      res.status(500).send("企業情報の取得に失敗しました");
      return;
    }

    const companyId = companyResults[0].company_id; // 企業IDを取得

    // **2. すでに回答があるか確認**
    const checkQuery = 'SELECT id FROM answers WHERE question_id = ?';

    connection.query(checkQuery, [question_id], (error, results) => {
      if (error) {
        console.error(error);
        res.status(500).send("回答チェックエラー");
        return;
      }

      if (results.length > 0) {
        // **3. すでに回答がある場合は更新**
        const updateQuery = 'UPDATE answers SET answer_text = ?, created_at = NOW() WHERE question_id = ?';

        connection.query(updateQuery, [answer_text, question_id], (error) => {
          if (error) {
            console.error(error);
            res.status(500).send("回答の更新に失敗しました");
            return;
          }
          res.redirect(`/company/${companyId}`);
        });
      } else {
        // **4. 新しい回答を追加**
        const insertQuery = 'INSERT INTO answers (question_id, answer_text, created_at, user_id) VALUES (?, ?, NOW(), ?)';

        connection.query(insertQuery, [question_id, answer_text, req.session.userId], (error) => {
          if (error) {
            console.error(error);
            res.status(500).send("回答の追加に失敗しました");
            return;
          }
          res.redirect(`/company/${companyId}`);
        });
      }
    });
  });
});

// カテゴリで質問を絞り込む
app.get('/category/:id', (req, res) => {
  const categoryId = req.params.id;
  connection.query(
    'SELECT q.id, q.question_text, co.name AS company FROM questions q JOIN companies co ON q.company_id = co.id WHERE q.category_id = ?',
    [categoryId],
    (error, results) => {
      if (error) throw error;
      res.render('filtered_questions.ejs', { questions: results });
    }
  );
});


// サーバー起動
app.listen(3000, () => {
  console.log('Server is running on port 3000');
});