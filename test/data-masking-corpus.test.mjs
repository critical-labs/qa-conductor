// The masking regression corpus (#35, from round 6 of its review): every
// shape a review round has reported, as one table. Each case is a value
// (in a neutral field, `note`) or a whole row, with the secrets that must
// never show. A masking change must keep every one of them hidden: three
// rounds in a row, a fix for one shape unmasked another an earlier head had
// masked. KNOWN_MISSES are shapes no head has masked yet; the README lists
// them under "what masking misses", and a change that masks one should move
// it out of the list.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createMasker, sanitizeSnapshot, validateRules } from '../lib/data-diff.mjs'

const KEY = Buffer.alloc(32, 7)
const rules = validateRules({})
const masker = createMasker({ key: KEY, rules })
const snap = collections => sanitizeSnapshot({ collections }, { masker, rules })
const cell = v => JSON.stringify(snap({ c: { key: ['id'], rows: [{ id: 1, note: v }] } }).collections.c.rows[0].note)
const row = r => JSON.stringify(snap({ c: { key: null, rows: [r] } }).collections.c.rows[0])

const S = 'Zq9SeCr3tVal'
const H = 'hunter2Zq'
const tok = ['gh', 'p_'].join('') + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
const b64 = Buffer.from(`bot:${S}`).toString('base64')
const triple = JSON.stringify(JSON.stringify(JSON.stringify({ password: S, user: 'a' })))

// [value, ...secrets] in field `note`
const cells = {
  // ---- probe-d2 / probe-corpus (rounds 3-5)
  empty_user: ['cache at redis://:redis-pw-9@cache:6379/0', 'redis-pw-9'],
  at_in_pw: ['postgres://app:p@ss-word-9@db:5432/app', 'ss-word-9'],
  u_alone: [`git remote https://${tok}@github.com/o/r.git`, tok],
  u_user_x_oauth: [`git remote https://${tok}:x-oauth-basic@github.com/o/r.git`, tok],
  u_user_empty_pw: [`https://${tok}:@github.com/o/r.git`, tok],
  scheme_lower: ['sent header bearer abcdefghij123456 ok', 'abcdefghij123456'],
  scheme_upper: ['BEARER abcdefghij123456', 'abcdefghij123456'],
  scheme_mixed: ['BeArEr abcdefghij123456', 'abcdefghij123456'],
  basic_short_b64: ['auth=Basic dXNlcjpwYXNz ok', 'dXNlcjpwYXNz'],
  basic_b64_pad: ['auth=Basic YWRtaW46YWRtaW4= ok', 'YWRtaW46YWRtaW4='],
  basic_header_only: ['Authorization header: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
  scheme_short_alpha: ['send Token abcdefghij to it', 'abcdefghij'],
  wsse: ['<soap:Header><wsse:Password Type="PasswordText">soap-secret-9</wsse:Password></soap:Header>', 'soap-secret-9'],
  xml_attr: ['<password type="text">attr-secret-9</password>', 'attr-secret-9'],
  html_quot: ['data-config="{&quot;password&quot;:&quot;html-secret-9&quot;}"', 'html-secret-9'],
  html_34: ['data-config="{&#34;password&#34;:&#34;html-secret-8&#34;}"', 'html-secret-8'],
  html_x22: ['data-config="{&#x22;password&#x22;:&#x22;html-secret-7&#x22;}"', 'html-secret-7'],
  html_X22_upper: ['data-config="{&#X22;password&#X22;:&#X22;html-secret-6&#X22;}"', 'html-secret-6'],
  html_QUOT_upper: ['data-config="{&QUOT;password&QUOT;:&QUOT;html-secret-5&QUOT;}"', 'html-secret-5'],
  html_Quot_mixed: [`cfg={&Quot;password&Quot;:&Quot;${S}&Quot;}`, S],
  html_apos: [`cfg=&apos;password&apos;: &apos;${S}&apos;`, S],
  html_x27: [`cfg=&#x27;password&#x27;: &#x27;${S}&#x27;`, S],
  newline_key: ['log line\\npassword=hunter2', 'hunter2'],
  win_path_key: ['C:\\Users\\x\\api_key=abc123', 'abc123'],
  spaced: ['password : spaced-secret-9', 'spaced-secret-9'],
  url_userinfo: [`postgres://app:${S}@db:5432/x`, S],
  url_empty_user: [`redis://:${S}@cache:6379`, S],
  token_user_with_pw: [`https://${tok}:pw-${S}@github.com/o/r.git`, tok, S],
  bearer: [`Authorization header was Bearer ${S}abcdefgh`, S],
  basic_b64_bot: [`Authorization: Basic ${b64}`, b64],
  basic_lower_b64: ['authorization: basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
  key_eq: [`password=${S}`, S],
  esc_quotes: [`{\\"password\\": \\"${S}\\"}`, S],
  tag_ns: [`<wsse:Password Type="x">${S}</wsse:Password>`, S],
  yaml: [`db:\n  password: ${S}\n`, S],
  mysql_backtick: [`UPDATE \`users\` SET \`password\` = '${S}' WHERE id = 1`, S],
  md_inline: [`\`password\`: ${S}`, S],
  cli_flag_space: [`pg_dump --password ${S} --host db`, S],
  cli_flag_eq: [`run --password=${S}`, S],
  cli_db_token: [`run --db-token=${S}`, S],
  cli_single_dash: [`tool -password ${S}`, S],
  cli_p_glued: [`mysql -uroot -p${S} app`, S],
  mysqldump_p: [`mysqldump -u root -p${S} app > x.sql`, S],
  go_dsn: [`root:${S}@tcp(127.0.0.1:3306)/app`, S],
  go_dsn_unix: [`root:${S}@unix(/tmp/mysql.sock)/app`, S],
  go_dsn_udp: [`u:${S}@udp(1.2.3.4)`, S],
  jwt: [`eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIke1NFQ1JFVH0ifQ.${S}sig`, S],
  form_body: [`grant_type=password&username=a&password%3D${S}`, S],
  pct_json: [`/cb?state=%7B%22password%22%3A%22${S}%22%7D`, S],
  pct_json_lower: [`/cb?state=%7b%22password%22%3a%22${S}%22%7d`, S],
  pct_json_2nd: [`/cb?state=%7B%22u%22%3A%22a%22%2C%22password%22%3A%22${S}%22%7D`, S],
  pct_dbl_query: [`next=%2Flogin%3Fuser%3Dbob%26password%3D${S}`, S],
  pct_q: [`redirect=%2Flogin%3Fpassword%3D${S}`, S],
  pct_at_start: [`password%3D${S}`, S],
  pct_at_start_lower: [`password%3d${S}`, S],
  pct_after_eq: [`state=%22password%22%3A%22${S}%22`, S],
  dotnet_add: [`<add key="DbPassword" value="${S}" />`, S],
  dotnet_add_value_first: [`<add value="${S}" key="DbPassword"/>`, S],
  dotnet_single: [`<add key='DbPassword' value='${S}' />`, S],
  dotnet_multiline: [`<add\n  key="DbPassword"\n  value="${S}"\n/>`, S],
  dotnet_amp: [`<add key="DbPassword" value="a&amp;${S}" />`, S],
  spring_prop: [`<property name="password" value="${S}"/>`, S],
  html_input: [`<input type="password" name="pw" value="${S}">`, S],
  aligned10: [`password          = ${S}`, S],
  sp32: [`password${' '.repeat(32)}= ${S}`, S],
  sp31: [`password${' '.repeat(31)}= ${S}`, S],
  tab_eq: [`password\t\t= ${S}`, S],
  pem: [`-----BEGIN RSA PRIVATE KEY-----\nMIIEow${S}IBAAKCAQEA\n-----END RSA PRIVATE KEY-----`, S],
  pem_openssh: [`-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl${S}\n-----END OPENSSH PRIVATE KEY-----`, S],
  pem_enc: [`-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIF${S}\n-----END ENCRYPTED PRIVATE KEY-----`, S],
  pem_pkcs8: [`-----BEGIN PRIVATE KEY-----\nMIIF${S}\n-----END PRIVATE KEY-----`, S],
  tag_attr_lt: [`<password hint="a<b">${S}</password>`, S],
  tag_attr_lt_ns: [`<wsse:Password Type="a<b">${S}</wsse:Password>`, S],
  tag_attr_lt_jsx: [`<Password placeholder="<enter>" />${S}`, S],
  tag_attr_lt_html: [`<secret data-tip="x < y">${S}</secret>`, S],
  tag_custom_lt: [`<secret-note title="x < y">${S}</secret-note>`, S],
  attr_tag_lt: [`<add key="DbPassword" note="a<b" value="${S}" />`, S],
  pct_eq_then_key: [`x%3dpassword=${S}`, S],
  pct_colon_then_key: [`x%3Apassword: ${S}`, S],
  pct_value_db_token: [`value%3a${S}--db-token=`, S],
  pct_state_token: [`state%3A${S}token%22%3dtoken:`, S],
  pct_eq_then_key_json: [`q%3Dtoken%3D${S}`, S],
  pct_amp_form: [`next=%2Fcb%3Fstate%3Dabc%26password%3D${S}`, S],
  pgp_private: [`-----BEGIN PGP PRIVATE KEY BLOCK-----\n${S}\n-----END PGP PRIVATE KEY BLOCK-----`, S],
  flag_tab: [`pg_dump --password\t${S} --host db`, S],
  flag_newline: [`run --token\n${S}`, S],
  auth_lower_token: [`token ${S}`, S],
  auth_alpha16: ['Bearer abcdefghijklmnop', 'abcdefghijklmnop'],
  jwt_in_json_str: [{ note: `token is eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.${S}` }, S],
  ndjson: [`{"a":1}\n{"password":"${S}"}`, S],
  ndjson_bad_first: [`not json\n{"password":"${S}"}`, S],
  dbl: [JSON.stringify(JSON.stringify({ password: S })), S],
  triple: [JSON.stringify(JSON.stringify(JSON.stringify({ password: S }))), S],
  triple_in_text: [`log: ${triple}`, S],
  npm_auth: [`registry=https://r.example\n_auth=${b64}`, b64],
  key_backtick_space: [`\`api_key\`    :   ${S}`, S],
  pct_27: [`%27password%27%3A${S}`, S],
  // ---- probe-words (round 5)
  w_pw_plain: [`pw=${H}`, H],
  w_user_pw: [`user_pw=${H}`, H],
  w_pw_json_prose: [`x {"pw": "${H}"}`, H],
  w_pw_amp: [`a=1&pw=${H}`, H],
  w_pw_pct26: [`next=%2Fx%3Fa%3D1%26pw%3D${H}`, H],
  w_pw_pct22: [`s=%7B%22pw%22%3A%22${H}%22%7D`, H],
  w_pin_pct26: [`q=%26pin%3D${H}`, H],
  w_auth_pct0a: [`npmrc=registry%3Dx%0A_auth%3D${H}`, H],
  w_auth_bsn: [`registry=x\\n_auth=${H}`, H],
  w_pw_bsn: [`a=1\\npw=${H}`, H],
  w_psk_bst: [`a=1\\tpsk=${H}`, H],
  // ---- probe-newpaths (round 5 residuals)
  np_add_single_dq_inside: [`<add key='DbPassword' value='a"${S}'/>`, S],
  np_input_gt_in_value: [`<input type="password" value="a>${S}">`, S],
  np_add_unquoted: [`<add key="DbPassword" value=${S} />`, S],
  np_add_long_attr: [`<add key="DbPassword" description="${'d'.repeat(1100)}" value="${S}"/>`, S],
  np_putty: [`PuTTY-User-Key-File-2: ssh-rsa\nEncryption: none\nPrivate-Lines: 14\n${S}`, S],
  // ---- round 6: tags read by name alone
  t_self_close: [`<password/>${S}`, S],
  t_self_close_sp: [`<password />${S}`, S],
  t_self_close_ns: [`<wsse:Password/>${S}`, S],
  t_apikey_self: [`<apiKey/>${S}`, S],
  t_split_lines: [`<password\n  type="x"\n>${S}</password>`, S],
  t_split_ns: [`<wsse:Password\nType="PasswordText">${S}</wsse:Password>`, S],
  t_tab: [`<password\t>${S}</password>`, S],
  t_crlf: [`<password\r\n>${S}</password>`, S],
  t_nbsp: [`<password\u00a0x="1">${S}</password>`, S],
  t_no_gt: [`<password ${S}`, S],
  t_open_eol: [`<password`, 'password'],
  t_close_only: [`${S}</password>`, S],
  t_close_ns_only: [`${S}</wsse:Password>`, S],
  t_ns_secret_only: [`<password:x>${S}</password:x>`, S],
  t_dbl_ns: [`<a:b:password>${S}</a:b:password>`, S],
  t_upper: [`<PASSWORD>${S}</PASSWORD>`, S],
  t_long_attrs: [`<password ${'a="1" '.repeat(60)}>${S}</password>`, S],
  t_gt_in_attr: [`<password hint="a>b">${S}</password>`, S],
  t_attr_quote_lt: [`<token kind='<x>'>${S}</token>`, S],
  t_html_escaped: [`&lt;password&gt;${S}&lt;/password&gt;`, S],
  t_pct_escaped: [`%3Cpassword%3E${S}%3C%2Fpassword%3E`, S],
  t_json_escaped: [`\\u003cpassword\\u003e${S}\\u003c/password\\u003e`, S],
  t_cdata: [`<password><![CDATA[${S}]]></password>`, S],
  t_dash_name: [`<db-password>${S}</db-password>`, S],
  t_dot_name: [`<app.secret>${S}</app.secret>`, S],
  t_bang: [`<!password>${S}`, S],
  t_question: [`<?password ${S}?>`, S],
  // ---- round 6: keys after a percent-escape
  p_any_hex: [`x%41password=${S}`, S],
  p_2f: [`a%2Fpassword=${S}`, S],
  p_5b: [`user%5Bpassword%5D=${S}`, S],
  p_5b_rb: [`user%5Bpassword]=${S}`, S],
  p_dbl_pct: [`q=%2522password%2522%253A%2522${S}`, S],
  p_dbl_pct_amp: [`q=a%253D1%2526password%253D${S}`, S],
  p_smart_quote: [`%E2%80%9Cpassword%E2%80%9D: ${S}`, S],
  p_pin_3d: [`x%3dpin=${S}`, S],
  p_pw_3a: [`x%3Apw: ${S}`, S],
  p_auth_0a: [`a%0Aauth=${S}`, S],
  p_auth_0d0a: [`a%0D%0A_auth%3D${S}`, S],
  p_psk_09: [`a%09psk%3d${S}`, S],
  p_pw_20: [`a%20pw%3D${S}`, S],
  p_pw_2b: [`a%2Bpw%3D${S}`, S],
  p_pw_22_upper: [`%22PW%22%3A%22${S}%22`, S],
  p_auth_upper: [`%26AUTH%3D${S}`, S],
  p_pin_hexlike: [`%26pinpin=${S}`, S],
  p_bs_r: [`a\\rpw=${S}`, S],
  p_bs_bs_n: [`a\\\\npw=${S}`, S],
  p_bs_u: [`a\\u0026pw=${S}`, S],
  p_bs_x: [`a\\x26pw=${S}`, S],
  p_amp_entity: [`a&amp;pw=${S}`, S],
  p_html_num: [`a&#38;pw=${S}`, S],
  p_pct_then_quote: [`%26%22pw%22%3A${S}`, S],
  p_unicode_esc: [`\\u0022password\\u0022: ${S}`, S],
  // ---- round 6: DSNs
  d_tcp: [`root:${S}@tcp(127.0.0.1:3306)/app`, S],
  d_tcp6: [`root:${S}@tcp6([::1]:3306)/app`, S],
  d_cloudsql: [`root:${S}@cloudsql(proj:region:inst)/app`, S],
  d_slash: [`root:${S}@/app`, S],
  d_paren: [`root:${S}@(localhost)/app`, S],
  d_upper: [`root:${S}@TCP(h)/app`, S],
  d_at_in_pw: [`root:p@ss${S}@tcp(127.0.0.1:3306)/app`, 'p@ss', S],
  d_colon_in_pw: [`root:Zq9Se:Cr3tVal@tcp(127.0.0.1:3306)/app`, 'Zq9Se', 'Cr3tVal'],
  d_colon_end_pw: [`root:${S}:@tcp(127.0.0.1:3306)/app`, S],
  d_colon_start_pw: [`root::${S}@tcp(127.0.0.1:3306)/app`, S],
  d_colon_unix: [`app:Zq9Se:Cr3tVal@unix(/tmp/m.sock)/db`, 'Zq9Se', 'Cr3tVal'],
  d_colon_udp: [`app:Zq9Se:Cr3tVal@udp(h:1)/db`, 'Zq9Se', 'Cr3tVal'],
  d_colon_in_url_q: [`dsn root:Zq9Se:Cr3tVal@tcp(db:3306)/app?parseTime=true`, 'Zq9Se', 'Cr3tVal'],
  d_colon_and_at: [`root:Zq9:S@eCr3tVal@tcp(h)/a`, 'Zq9', 'eCr3tVal'],
  d_slash_pw: [`root:pa/${S}@tcp(h)/a`, S],
  d_space_before: [`connecting root:${S}@tcp(h)/a now`, S],
  d_quoted: [`"root:${S}@tcp(h)/a"`, S],
  d_json_val: [{ conn: `root:${S}@tcp(h)/a` }, S],
  d_env_line: [`MYSQL=root:${S}@tcp(h)/a`, S],
  d_after_semicolon: [`x;root:${S}@tcp(h)/a`, S],
  // ---- round 6: elements and attributes
  a_upper_names: [`<add KEY='DbPassword' VALUE='${S}'/>`, S],
  a_id: [`<x id="password" value="${S}">`, S],
  a_type_unquoted: [`<input type=password value=${S}>`, S],
  a_name_unquoted: [`<input name=password value=${S}>`, S],
  a_spaces_eq: [`<add key = "DbPassword" value = "${S}" />`, S],
  a_apostrophe: [`<add key="DbPassword" value="it's${S}" />`, S],
  a_mixed_quote_name: [`<add key="DbPassword' value="${S}" />`, S],
  a_name_with_apos: [`<add key="Db'Password" value="${S}" />`, S],
  a_two_values: [`<add key="DbPassword" value="${S}" value2="x"/>`, S],
  a_data_value: [`<add key="DbPassword" data-value="x" value="${S}"/>`, S],
  a_tab_sep: [`<add\tkey="DbPassword"\tvalue="${S}"/>`, S],
  a_ns_elem: [`<x:add key="DbPassword" value="${S}"/>`, S],
  a_value_empty_then: [`<add key="DbPassword" value="" note="${S}"/>`, S],
  a_minified_after: [`<input type="password" value="${S}" class="a:b"><td>x@y(z)</td>`, S],
  a_minified_after2: [`<input type="password" value="${S}" style="color:red"><b>a@/b</b>`, S],
  a_value_colon: [`<input type="password" value="ab:${S}"><i>x@/</i>`, S],
  a_selfclose_then_dsn: [`<add key="DbPassword" value="${S}" x="a:b"/>@/`, S],
  a_then_dsn_tag: [`<add key="DbPassword" value="${S}" note="t:1"><add key="Dsn" value="root:pw@/db"/>`, S],
}

// [row, ...secrets]: whole rows (field names matter)
const rows = {
  col_pw: [{ id: 1, pw: S }, S],
  col_psk: [{ id: 1, psk: S }, S],
  col_auth: [{ id: 1, auth: b64 }, b64],
  col__auth: [{ id: 1, _auth: b64 }, b64],
  col_Auth: [{ id: 1, Auth: b64 }, b64],
  col_auth_token: [{ id: 1, auth_token: S }, S],
  docker_auths: [{ id: 1, config: { auths: { 'ghcr.io': { auth: b64 } } } }, b64],
  json_user_pw: [{ id: 1, creds_json: { user: 'admin', pw: S } }, S],
  // JSON pairs inside a column
  aws_name: [{ id: 1, doc: [{ Name: 'db-password', Value: 'aws-secret-9' }] }, 'aws-secret-9'],
  aws_key: [{ id: 1, doc: [{ Key: 'api_token', Value: 'tag-secret-9' }] }, 'tag-secret-9'],
  field_val: [{ id: 1, doc: [{ field: 'password', val: 'fv-secret-9' }] }, 'fv-secret-9'],
  k_v: [{ id: 1, doc: [{ k: 'password', v: 'kv-secret-9' }] }, 'kv-secret-9'],
  NAME_VALUE: [{ id: 1, doc: [{ NAME: 'password', VALUE: 'upper-secret-9' }] }, 'upper-secret-9'],
  pair7: [{ id: 1, doc: [{ name: 'password', value: 'seven-secret-9', a: 1, b: 2, c: 3, d: 4, e: 5 }] }, 'seven-secret-9'],
  har: [{ id: 1, doc: [{ name: 'session', value: 'har-cookie-9', path: '/', domain: 'x.test', expires: null, httpOnly: true, secure: true, sameSite: 'Lax' }] }, 'har-cookie-9'],
  ssm: [{ id: 1, doc: { Parameter: { Name: '/prod/db-password', Type: 'SecureString', Value: 'ssm-secret-9', Version: 1, LastModifiedDate: '2026-01-01', ARN: 'arn:x', DataType: 'text' } } }, 'ssm-secret-9'],
  pair_two_values: [{ id: 1, doc: [{ name: 'password', value: 'v1-secret-9', v: 'v2-secret-9' }] }, 'v1-secret-9', 'v2-secret-9'],
  pair_name_second: [{ id: 1, doc: [{ field: 'x', name: 'password', value: S }] }, S],
  pair_k_first: [{ id: 1, doc: [{ k: 'id', key: 'api_token', value: S }] }, S],
  pair_name_null: [{ id: 1, doc: [{ name: null, key: 'password', value: S }] }, S],
  pair_name_num: [{ id: 1, doc: [{ name: 7, key: 'password', value: S }] }, S],
  pair_value_obj: [{ id: 1, doc: [{ name: 'password', value: { inner: S } }] }, S],
  raw_headers: [{ id: 1, doc: ['Authorization', `Bearer ${S}`, 'X-Api-Key', S] }, S],
  k8s_env: [{ id: 1, doc: { env: [{ name: 'DB_PASSWORD', value: S }, { name: 'HOST', value: 'db' }] } }, S],
  key_mail_smtp: [{ id: 1, doc: [{ key: 'mail.smtp', name: 'Password', value: S }] }, S],
  k_row17: [{ id: 1, doc: [{ k: 'row-17', name: 'password', value: S }] }, S],
  setting42: [{ id: 1, doc: { key: 'setting_42', name: 'SMTP password', value: S, updated: 1 } }, S],
  pair_key10: [{ id: 1, doc: [{ key: 'password', value: S, a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10 }] }, S],
  pair_Key5: [{ id: 1, doc: [{ Key: 'api_token', Value: S, a: 1, b: 2, c: 3, d: 4, e: 5 }] }, S],
  // round 6: rows shaped as pairs (settings tables)
  r_settings_key: [{ id: 1, key: 'smtp_password', value: S }, S],
  r_settings_name: [{ id: 1, name: 'STRIPE_SECRET_KEY', value: S }, S],
  r_settings_kv: [{ k: 'api_token', v: S }, S],
  r_settings_field_val: [{ id: 1, field: 'pw', val: S }, S],
  r_settings_KeyValue: [{ Id: 1, Key: 'DbPassword', Value: S }, S],
  r_settings_KEY_VALUE7: [{ ID: 1, KEY: 'DbPassword', VALUE: S, a: 1, b: 2, c: 3, d: 4 }, S],
  r_settings_wide: [{ id: 1, key: 'smtp_password', value: S, group: 'mail', updated_at: 'x', created_at: 'y', autoload: true, type: 'string', note: 'n' }, S],
  r_settings_loose_wide: [{ id: 1, k: 'smtp_password', v: S, group: 'mail', updated_at: 'x', created_at: 'y', autoload: true }, S],
  r_settings_value_json: [{ id: 1, key: 'smtp', value: JSON.stringify({ password: S }) }, S],
  r_settings_value_text: [{ id: 1, key: 'dsn_note', value: `x ${S}` }, S],
  r_option_name: [{ id: 1, option_name: 'mailserver_pass', option_value: S }, S],
  r_setting_value: [{ id: 1, setting: 'smtp_password', value: S }, S],
  r_value_number: [{ id: 1, key: 'pin', value: 482913 }, '482913'],
  r_value_buffer: [{ id: 1, key: 'secret', value: Buffer.from(S) }, S],
}


// Round 6's highs, and its own corpus of them.
Object.assign(cells, {
  r6_dsn_pa_ss: [`root:pa:ss${S}@tcp(127.0.0.1:3306)/app`, S],
  r6_dsn_pw_colon: [`root:${S}:@tcp(db)/app`, S],
  r6_dsn_colon_pw: [`root::${S}@tcp(db)/app`, S],
  r6_dsn_colon_mid: [`root:Zq9Se:Cr3tVal@tcp(db)/app`, 'Zq9Se', 'Cr3tVal'],
  r6_elem_style_media: [`<input type="password" name="pw" value="${S}" style="width:100%"><style>@media(max-width:1px){}</style>`, S],
  r6_elem_hidden_supports: [`<input type="hidden" name="api_token" value="${S}" style="display:none"><style>@supports(x:y){}</style>`, S],
  r6_elem_mailto: [`<x id="secret" value="${S}" href="mailto:a@b.c">x</x>`, S],
  r6_elem_slash: [`<input type="password" value="${S}" style="a:b">x@/y`, S],
  // the round's own differential fuzz: a scheme's word that isn't a token
  // before the real one, and a scheme in an unquoted element value
  r6_auth_after_word: [`x Bearer //bearer  ${S}mysql://u:%26value\t=`, S],
  r6_elem_unquoted_bearer: [`<input type=password value=Bearer ${S}:"/>`, S],
  r6_elem_unquoted_basic: [`;<input type=password value=Basic ${S},x"/>`, S],
})

const KNOWN_MISSES = new Set(['scheme_short_alpha', 'attr_tag_lt', 'np_input_gt_in_value', 't_open_eol', 't_close_only', 't_close_ns_only', 't_dbl_ns', 't_html_escaped', 't_pct_escaped', 't_json_escaped', 't_bang', 't_question', 'p_5b', 'p_dbl_pct', 'p_dbl_pct_amp', 'p_smart_quote', 'p_pin_hexlike', 'p_bs_u', 'p_bs_x', 'p_unicode_esc', 'd_slash_pw', 'a_value_empty_then', 'r_settings_KEY_VALUE7', 'r_settings_loose_wide', 'r_option_name', 'r_setting_value'])

test('the masking corpus: every shape a review reported as masked stays masked', () => {
  const shown = []
  for (const [kind, table, read] of [['cell', cells, cell], ['row', rows, row]]) {
    for (const [name, [value, ...secrets]] of Object.entries(table)) {
      if (KNOWN_MISSES.has(name)) continue
      const out = read(value)
      const leaked = secrets.filter(secret => out.includes(secret))
      if (leaked.length) shown.push(`${kind} ${name}: ${out}`)
    }
  }
  assert.deepEqual(shown, [])
  assert.ok(Object.keys(cells).length + Object.keys(rows).length > 250)
})

test('the masking corpus\'s known misses are still the corpus\'s, so the list stays honest', () => {
  for (const name of KNOWN_MISSES) assert.ok(Object.hasOwn(cells, name) || Object.hasOwn(rows, name), name)
})
