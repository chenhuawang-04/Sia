use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    #[serde(default = "default_version")]
    pub version: u32,
    pub title: String,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub relationships: Vec<Relationship>,
    pub root: Node,
}

fn default_version() -> u32 { 1 }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub note: String,
    #[serde(default = "default_color")]
    pub color: String,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub images: Vec<ImageMetadata>,
    #[serde(default)]
    pub annotations: Vec<Annotation>,
    #[serde(default)]
    pub children: Vec<Node>,
}

fn default_color() -> String { "violet".into() }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageMetadata {
    pub id: String,
    pub file: String,
    #[serde(default)]
    pub name: String,
    pub mime: String,
    pub size: u64,
    #[serde(default)]
    pub sha256: Option<String>,
    pub url: String,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Relationship {
    pub id: String,
    pub source_id: String,
    pub target_id: String,
    #[serde(rename = "type")]
    pub relationship_type: RelationshipType,
    #[serde(default)]
    pub topic: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RelationshipType {
    Bidirectional,
    AToB,
    BToA,
    Undirected,
}
