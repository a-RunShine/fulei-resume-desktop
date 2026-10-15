use std::fs;
use std::path::{Path, PathBuf};
use std::thread;

use rusqlite::{params, Connection};
use serde_json::{json, Value};
use tiny_http::{Header, Method, Response, Server, StatusCode};

pub const PORT: u16 = 47821;

const USER_ID: &str = "local-user";

pub fn start(dist: PathBuf, database: PathBuf) {
	let server = Server::http(format!("127.0.0.1:{PORT}")).expect("desktop api port is busy");
	thread::spawn(move || {
		for mut request in server.incoming_requests() {
			let mut body = String::new();
			let _ = request.as_reader().read_to_string(&mut body);
			let outcome = dispatch(request.method(), request.url(), &body, &dist, &database);
			let mut response = Response::from_data(outcome.body);
			if let Ok(header) = Header::from_bytes("Content-Type", outcome.content_type.as_bytes()) {
				response = response.with_header(header);
			}
			if let Some(location) = outcome.redirect {
				if let Ok(header) = Header::from_bytes("Location", location.as_bytes()) {
					response = response.with_header(header);
				}
			}
			let _ = request.respond(response.with_status_code(StatusCode(outcome.status)));
		}
	});
}

struct Outcome {
	status: u16,
	content_type: String,
	body: Vec<u8>,
	redirect: Option<String>,
}

fn outcome(status: u16, content_type: &str, body: impl Into<Vec<u8>>) -> Outcome {
	Outcome {
		status,
		content_type: content_type.to_string(),
		body: body.into(),
		redirect: None,
	}
}

fn dispatch(_method: &Method, url: &str, body: &str, dist: &Path, database: &Path) -> Outcome {
	let path = url.split('?').next().unwrap_or(url);
	if path == "/" {
		return Outcome {
			status: 302,
			content_type: "text/plain".to_string(),
			body: b"dashboard".to_vec(),
			redirect: Some("/dashboard".to_string()),
		};
	}
	if path == "/api/auth/get-session" {
		return outcome(200, "application/json", session_body().to_string());
	}
	if path.starts_with("/api/rpc/") {
		return outcome(200, "application/json", rpc(path, body, database).to_string());
	}
	if path.starts_with("/api/") {
		return outcome(200, "application/json", r#"{"json":null}"#);
	}
	serve_file(dist, path)
}

fn session_body() -> Value {
	let now = "2026-01-01T00:00:00.000Z";
	json!({
		"session": {
			"id": "local-session",
			"userId": USER_ID,
			"expiresAt": "2099-01-01T00:00:00.000Z",
			"token": "local",
			"createdAt": now,
			"updatedAt": now,
			"ipAddress": "127.0.0.1",
			"userAgent": "desktop"
		},
		"user": {
			"id": USER_ID,
			"name": "Local",
			"email": "local@localhost",
			"emailVerified": true,
			"image": null,
			"createdAt": now,
			"updatedAt": now,
			"isAnonymous": false,
			"twoFactorEnabled": false,
			"username": "local"
		}
	})
}

fn rpc(path: &str, body: &str, database: &Path) -> Value {
	let procedure = path.trim_start_matches("/api/rpc/").trim_end_matches('/');
	if let Some(prefix) = procedure.strip_suffix("/__batch__") {
		let items = serde_json::from_str::<Vec<Value>>(body).unwrap_or_default();
		let responses = items
			.into_iter()
			.enumerate()
			.map(|(index, item)| {
				let url = item.get("url").and_then(Value::as_str).unwrap_or(prefix);
				let input = item.pointer("/body/json").cloned().unwrap_or(json!({}));
				json!({
					"index": index,
					"status": 200,
					"headers": {},
					"body": { "json": call(url, &input, database) }
				})
			})
			.collect::<Vec<_>>();
		return Value::Array(responses);
	}
	let input = serde_json::from_str::<Value>(body)
		.ok()
		.and_then(|value| value.get("json").cloned())
		.unwrap_or(json!({}));
	json!({ "json": call(procedure, &input, database) })
}

fn call(url_or_procedure: &str, input: &Value, database: &Path) -> Value {
	let procedure = url_or_procedure
		.split("/api/rpc/")
		.last()
		.unwrap_or(url_or_procedure)
		.trim_end_matches('/')
		.trim_end_matches("/__batch__");
	match procedure {
		"flags/get" => json!({
			"disableSignups": true,
			"disableEmailAuth": true,
			"allowGuestLogin": false,
			"smtpEnabled": false,
			"careerSchedulingEnabled": false
		}),
		"documents/counts" => json!({
			"resume": load_all(database).len(),
			"letter": 0,
			"trash": 0
		}),
		"documents/list" => {
			if input.get("trashed").and_then(Value::as_bool) == Some(true) {
				json!([])
			} else {
				Value::Array(load_all(database).into_iter().map(document_summary).collect())
			}
		}
		"resume/list" => Value::Array(load_all(database).into_iter().map(|mut record| {
			record.as_object_mut().map(|object| {
				object.remove("data");
			});
			record
		}).collect()),
		"resume/getById" => load_one(database, input.get("id").and_then(Value::as_str).unwrap_or("")).unwrap_or(json!(null)),
		"resume/create" => json!(create_resume(database, input)),
		"resume/update" => update_resume(database, input),
		other if other.ends_with("/list") => json!([]),
		other if other.ends_with("/counts") => json!({ "resume": 0, "letter": 0, "trash": 0 }),
		_ => json!(null),
	}
}

fn document_summary(record: Value) -> Value {
	json!({
		"type": "resume",
		"id": record.get("id").cloned().unwrap_or(json!("")),
		"name": record.get("name").cloned().unwrap_or(json!("Resume")),
		"tags": record.get("tags").cloned().unwrap_or(json!([])),
		"isLocked": record.get("isLocked").cloned().unwrap_or(json!(false)),
		"isPublic": record.get("isPublic").cloned().unwrap_or(json!(false)),
		"slug": record.get("slug").cloned().unwrap_or(Value::Null),
		"trashedAt": null,
		"createdAt": record.get("createdAt").cloned().unwrap_or(json!("")),
		"updatedAt": record.get("updatedAt").cloned().unwrap_or(json!("")),
		"application": null
	})
}

fn create_resume(database: &Path, input: &Value) -> String {
	let name = input.get("name").and_then(Value::as_str).unwrap_or("Resume");
	let id = format!("resume-{}", now_millis());
	let mut data = default_data();
	data["basics"]["name"] = json!(name);
	let record = json!({
		"id": id,
		"name": name,
		"slug": slugify(name),
		"tags": input.get("tags").cloned().unwrap_or(json!([])),
		"isPublic": false,
		"showDownloadButtons": true,
		"isLocked": false,
		"data": data,
		"createdAt": now_stamp(),
		"updatedAt": now_stamp(),
		"hasPassword": false,
		"applicationId": null
	});
	save(database, &record);
	id
}

fn update_resume(database: &Path, input: &Value) -> Value {
	let id = input.get("id").and_then(Value::as_str).unwrap_or("");
	let Some(mut record) = load_one(database, id) else {
		return json!(null);
	};
	if let Some(name) = input.get("name").and_then(Value::as_str) {
		record["name"] = json!(name);
	}
	if let Some(data) = input.get("data") {
		record["data"] = data.clone();
		if let Some(name) = data.pointer("/basics/name").and_then(Value::as_str) {
			if !name.is_empty() {
				record["name"] = json!(name);
			}
		}
	}
	for key in ["slug", "tags", "isPublic", "showDownloadButtons", "isLocked"] {
		if let Some(value) = input.get(key) {
			record[key] = value.clone();
		}
	}
	record["updatedAt"] = json!(now_stamp());
	save(database, &record);
	record
}

fn connection(database: &Path) -> Connection {
	if let Some(parent) = database.parent() {
		let _ = fs::create_dir_all(parent);
	}
	let connection = Connection::open(database).expect("open resume database");
	connection
		.execute(
			"CREATE TABLE IF NOT EXISTS resume (id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
			[],
		)
		.expect("create resume table");
	connection
}

fn load_all(database: &Path) -> Vec<Value> {
	let connection = connection(database);
	let mut statement = connection.prepare("SELECT payload FROM resume ORDER BY payload").expect("list resumes");
	statement
		.query_map([], |row| row.get::<_, String>(0))
		.expect("query resumes")
		.filter_map(Result::ok)
		.filter_map(|payload| serde_json::from_str(&payload).ok())
		.collect()
}

fn load_one(database: &Path, id: &str) -> Option<Value> {
	let connection = connection(database);
	connection
		.query_row("SELECT payload FROM resume WHERE id = ?1", params![id], |row| row.get::<_, String>(0))
		.ok()
		.and_then(|payload| serde_json::from_str(&payload).ok())
}

fn save(database: &Path, record: &Value) {
	let id = record.get("id").and_then(Value::as_str).unwrap_or("");
	let connection = connection(database);
	connection
		.execute(
			"INSERT INTO resume (id, payload) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
			params![id, record.to_string()],
		)
		.expect("save resume");
}

fn serve_file(dist: &Path, path: &str) -> Outcome {
	let relative = path.trim_start_matches('/');
	let candidate = if relative.is_empty() {
		dist.join("index.html")
	} else {
		dist.join(relative)
	};
	let file = if candidate.is_file() { candidate } else { dist.join("index.html") };
	match fs::read(&file) {
		Ok(bytes) => outcome(200, content_type(&file), bytes),
		Err(_) => outcome(404, "text/plain", "missing"),
	}
}

fn content_type(path: &Path) -> &'static str {
	match path.extension().and_then(|extension| extension.to_str()) {
		Some("html") => "text/html",
		Some("js") | Some("mjs") => "text/javascript",
		Some("css") => "text/css",
		Some("json") => "application/json",
		Some("svg") => "image/svg+xml",
		Some("png") => "image/png",
		Some("jpg") | Some("jpeg") => "image/jpeg",
		Some("webp") => "image/webp",
		Some("woff2") => "font/woff2",
		Some("wasm") => "application/wasm",
		_ => "application/octet-stream",
	}
}

fn section(icon: &str) -> Value {
	json!({
		"title": "",
		"icon": icon,
		"columns": 1,
		"hidden": false,
		"showHeading": true,
		"keepTogether": false,
		"startOnNewPage": false,
		"items": []
	})
}

fn default_data() -> Value {
	let mut skills = section("compass-tool");
	skills["layout"] = json!("default");
	skills["keywordLayout"] = json!("inline");
	json!({
		"picture": {
			"hidden": true,
			"fit": "cover",
			"url": "",
			"size": 80,
			"rotation": 0,
			"aspectRatio": 1,
			"borderRadius": 0,
			"borderColor": "rgba(0, 0, 0, 0.5)",
			"borderWidth": 0,
			"shadowColor": "rgba(0, 0, 0, 0.5)",
			"shadowWidth": 0
		},
		"basics": {
			"name": "",
			"headline": "",
			"email": "",
			"phone": "",
			"location": "",
			"website": { "url": "", "label": "" },
			"customFields": []
		},
		"summary": {
			"title": "",
			"icon": "article",
			"columns": 1,
			"hidden": false,
			"showHeading": true,
			"keepTogether": false,
			"startOnNewPage": false,
			"content": ""
		},
		"sections": {
			"profiles": section("messenger-logo"),
			"experience": section("briefcase"),
			"education": section("graduation-cap"),
			"projects": section("code-simple"),
			"skills": skills,
			"languages": section("translate"),
			"interests": section("football"),
			"awards": section("trophy"),
			"certifications": section("certificate"),
			"publications": section("books"),
			"volunteer": section("hand-heart"),
			"references": section("phone")
		},
		"customSections": [],
		"metadata": {
			"template": "onyx",
			"layout": {
				"sidebarWidth": 35,
				"pages": [{
					"fullWidth": false,
					"main": ["profiles", "summary", "education", "experience", "projects", "volunteer", "references"],
					"sidebar": ["skills", "certifications", "awards", "languages", "interests", "publications"]
				}]
			},
			"page": {
				"gapX": 4,
				"gapY": 6,
				"marginX": 14,
				"marginY": 12,
				"format": "a4",
				"locale": "en-US",
				"dateFormat": "short",
				"hideLinkUnderline": false,
				"hideIcons": false,
				"hideSectionIcons": true
			},
			"design": {
				"colors": {
					"primary": "rgba(220, 38, 38, 1)",
					"text": "rgba(0, 0, 0, 1)",
					"background": "rgba(255, 255, 255, 1)"
				},
				"level": { "icon": "star", "type": "circle" }
			},
			"typography": {
				"body": { "fontFamily": "IBM Plex Serif", "fontWeights": ["400", "500"], "fontSize": 10, "lineHeight": 1.5 },
				"heading": { "fontFamily": "IBM Plex Serif", "fontWeights": ["600"], "fontSize": 14, "lineHeight": 1.5 }
			},
			"notes": "",
			"styleRules": []
		}
	})
}

fn slugify(name: &str) -> String {
	let slug: String = name
		.chars()
		.map(|character| if character.is_ascii_alphanumeric() { character.to_ascii_lowercase() } else { '-' })
		.collect();
	let trimmed = slug.trim_matches('-').to_string();
	if trimmed.is_empty() { "resume".to_string() } else { trimmed }
}

fn now_stamp() -> String {
	"2026-10-15T00:00:00.000Z".to_string()
}

fn now_millis() -> u128 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|duration| duration.as_millis())
		.unwrap_or(0)
}

pub fn database_file() -> PathBuf {
	let directory = std::env::current_exe()
		.ok()
		.and_then(|path| path.parent().map(Path::to_path_buf))
		.unwrap_or_else(|| PathBuf::from("."));
	directory.join("desktop-data").join("resumes.sqlite")
}

#[cfg(test)]
mod tests {
	use super::*;

	fn database() -> PathBuf {
		let path = std::env::temp_dir().join(format!("rr-desktop-api-{}-{}.sqlite", std::process::id(), now_millis()));
		let _ = fs::remove_file(&path);
		path
	}

	#[test]
	fn session_lists_and_keeps_a_renamed_resume() {
		let database = database();
		let session = dispatch(&Method::Get, "/api/auth/get-session", "", Path::new("."), &database);
		let session_json: Value = serde_json::from_slice(&session.body).unwrap();
		assert_eq!(session_json["user"]["id"], USER_ID);
		assert!(session_json.get("session").is_some());

		let created = dispatch(
			&Method::Post,
			"/api/rpc/resume/create",
			r#"{"json":{"name":"First"}}"#,
			Path::new("."),
			&database,
		);
		let created_json: Value = serde_json::from_slice(&created.body).unwrap();
		let id = created_json["json"].as_str().unwrap();

		let batch = serde_json::json!([
			{"body": {"json": {}}, "url": "http://127.0.0.1/api/rpc/flags/get"},
			{"body": {"json": {"id": id}}, "url": "http://127.0.0.1/api/rpc/resume/getById"}
		])
		.to_string();
		let batched = dispatch(&Method::Post, "/api/rpc/flags/get/__batch__", &batch, Path::new("."), &database);
		let batched_json: Value = serde_json::from_slice(&batched.body).unwrap();
		assert_eq!(batched_json[0]["body"]["json"]["disableSignups"], true);
		assert_eq!(batched_json[1]["body"]["json"]["data"]["basics"]["name"], "First");

		let update = serde_json::json!({ "json": { "id": id, "data": { "basics": { "name": "Second" } } } }).to_string();
		dispatch(&Method::Post, "/api/rpc/resume/update", &update, Path::new("."), &database);
		let loaded = dispatch(
			&Method::Post,
			"/api/rpc/resume/getById",
			&serde_json::json!({ "json": { "id": id } }).to_string(),
			Path::new("."),
			&database,
		);
		let loaded_json: Value = serde_json::from_slice(&loaded.body).unwrap();
		assert_eq!(loaded_json["json"]["data"]["basics"]["name"], "Second");
		assert_eq!(loaded_json["json"]["name"], "Second");
		let _ = fs::remove_file(database);
	}
}
