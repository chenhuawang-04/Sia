use std::collections::HashSet;
use thiserror::Error;
use crate::{Document, Node};

const COLORS: [&str; 4] = ["violet", "blue", "teal", "orange"];

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ValidationError {
    #[error("{0}")]
    Invalid(&'static str),
}

pub fn validate_document(document: &Document) -> Result<(), ValidationError> {
    if document.version != crate::DOCUMENT_SCHEMA_VERSION { return invalid("unsupported document version"); }
    if text_length(&document.title) > 160 { return invalid("title is too long"); }
    if document.relationships.len() > 500 { return invalid("too many relationships"); }
    let mut node_ids = HashSet::new();
    let mut annotation_ids = HashSet::new();
    let mut image_ids = HashSet::new();
    let mut node_count = 0usize;
    validate_node(&document.root, 0, &mut node_count, &mut node_ids, &mut annotation_ids, &mut image_ids)?;
    let mut relationship_ids = HashSet::new();
    for relationship in &document.relationships {
        if relationship.id.is_empty() || !relationship_ids.insert(&relationship.id) {
            return invalid("invalid or duplicate relationship id");
        }
        if relationship.source_id == relationship.target_id
            || !node_ids.contains(&relationship.source_id)
            || !node_ids.contains(&relationship.target_id) {
            return invalid("invalid relationship endpoints");
        }
        if text_length(&relationship.topic) > 80 { return invalid("relationship topic is too long"); }
        if text_length(&relationship.description) > 500 { return invalid("relationship description is too long"); }
    }
    Ok(())
}

fn validate_node<'a>(
    node: &'a Node,
    depth: usize,
    count: &mut usize,
    node_ids: &mut HashSet<&'a str>,
    annotation_ids: &mut HashSet<&'a str>,
    image_ids: &mut HashSet<&'a str>,
) -> Result<(), ValidationError> {
    *count += 1;
    if *count > 5000 { return invalid("too many nodes"); }
    if depth > 80 { return invalid("tree is too deep"); }
    if node.id.is_empty() || !node_ids.insert(&node.id) { return invalid("invalid or duplicate node id"); }
    if node.text.trim().is_empty() || text_length(&node.text) > 80 { return invalid("invalid node title"); }
    if text_length(&node.note) > 240 { return invalid("node description is too long"); }
    if !COLORS.contains(&node.color.as_str()) { return invalid("invalid node color"); }
    if node.children.len() > 500 { return invalid("too many direct children"); }
    if node.images.len() > 200 { return invalid("too many images on a node"); }
    if node.annotations.len() > 100 { return invalid("too many annotations on a node"); }
    for image in &node.images {
        if image.id.is_empty() || !image_ids.insert(&image.id) || !valid_image_file_name(&image.file)
            || image.url != format!("/uploads/{}", image.file)
            || image.size == 0 || image.size > 12_000_000 {
            return invalid("invalid image metadata");
        }
        if image.sha256.as_ref().is_some_and(|hash| hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))) {
            return invalid("invalid image hash");
        }
    }
    for annotation in &node.annotations {
        if annotation.id.is_empty() || !annotation_ids.insert(&annotation.id)
            || annotation.text.trim().is_empty() || text_length(&annotation.text) > 1000 {
            return invalid("invalid annotation");
        }
    }
    for child in &node.children {
        validate_node(child, depth + 1, count, node_ids, annotation_ids, image_ids)?;
    }
    Ok(())
}

fn text_length(value: &str) -> usize { value.chars().count() }

fn valid_image_file_name(value: &str) -> bool {
    let Some((stem, extension)) = value.rsplit_once('.') else { return false; };
    !stem.is_empty() && stem.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) || byte == b'-')
        && ["jpg", "jpeg", "png", "webp", "gif", "avif"].contains(&extension)
}

fn invalid<T>(message: &'static str) -> Result<T, ValidationError> {
    Err(ValidationError::Invalid(message))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Annotation, Document, Node};

    fn document() -> Document {
        Document { version: 1, title: "测试".into(), created_at: None, updated_at: None,
            relationships: vec![], root: Node { id: "root".into(), text: "中心".into(), note: "".into(),
                color: "violet".into(), collapsed: false, images: vec![], annotations: vec![], children: vec![] } }
    }

    #[test]
    fn accepts_minimal_document() { assert_eq!(validate_document(&document()), Ok(())); }

    #[test]
    fn rejects_duplicate_annotation_ids_across_nodes() {
        let mut value = document();
        value.root.annotations.push(Annotation { id: "same".into(), text: "一".into(), created_at: None, updated_at: None });
        let mut child = value.root.clone(); child.id = "child".into(); child.annotations[0].text = "二".into();
        value.root.children.push(child);
        assert!(validate_document(&value).is_err());
    }

    #[test]
    fn current_web_document_is_compatible() {
        let value: Document = serde_json::from_str(include_str!("../../../../data/mindmap.json")).expect("current document should deserialize");
        validate_document(&value).expect("current document should remain valid");
    }

    #[test]
    fn rejects_relationship_to_missing_node() {
        let mut value = document();
        value.relationships.push(crate::Relationship { id: "r".into(), source_id: "root".into(), target_id: "missing".into(),
            relationship_type: crate::RelationshipType::AToB, topic: "依赖".into(), description: String::new() });
        assert!(validate_document(&value).is_err());
    }

    #[test]
    fn unicode_limits_count_characters_not_utf8_bytes() {
        let mut value = document(); value.root.text = "知".repeat(80);
        assert!(validate_document(&value).is_ok());
        value.root.text.push('识'); assert!(validate_document(&value).is_err());
    }
}
